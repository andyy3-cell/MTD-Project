import "dotenv/config";
import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const API_BASE_URL = "https://api.mtd.dev";
const GTFS_URL = "https://developer.mtd.org/gtfs/google_transit.zip";
const GTFS_RT_TRIP_UPDATES_URL = "https://gtfs-rt.mtd.org/trip-updates";
const STOP_ID = process.env.MTD_STOP_ID || "5THARY:3";
const STOP_NAME = "5 Fifth & Armory (SW Corner)";
const PREVIEW_MINUTES = Number(process.env.MTD_PREVIEW_MINUTES || 60);
const POLL_INTERVAL_MS = Number(process.env.MTD_POLL_INTERVAL_SECONDS || 60) * 1000;
const MAX_REQUEST_ATTEMPTS = 3;
let gtfsCache;

function getApiKey() {
  const apiKey = process.env.MTD_API_KEY;
  if (!apiKey) {
    throw new Error("MTD_API_KEY is missing. Add it to .env.");
  }
  return apiKey;
}

async function getDepartures() {
  const url = new URL(`${API_BASE_URL}/stops/${encodeURIComponent(STOP_ID)}/departures`);
  url.searchParams.set("time", String(PREVIEW_MINUTES));

  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        "X-ApiKey": getApiKey(),
      },
    });
    const data = await response.json().catch(() => null);

    if (response.ok && Array.isArray(data?.result)) {
      return data.result;
    }

    const message = data?.error?.message || data?.message || response.statusText;
    if (attempt < MAX_REQUEST_ATTEMPTS && response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      continue;
    }

    throw new Error(`MTD API request failed (${response.status}): ${message}`);
  }
}

function readGtfsFile(zip, filename) {
  const entry = zip.getEntry(filename);
  if (!entry) {
    throw new Error(`GTFS feed is missing ${filename}.`);
  }
  return parse(entry.getData().toString("utf8"), {
    columns: true,
    skip_empty_lines: true,
  });
}

async function getGtfsData() {
  if (gtfsCache) return gtfsCache;

  const response = await fetch(GTFS_URL);
  if (!response.ok) {
    throw new Error(`GTFS download failed (${response.status}): ${response.statusText}`);
  }

  const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
  gtfsCache = {
    calendar: readGtfsFile(zip, "calendar.txt"),
    calendarDates: readGtfsFile(zip, "calendar_dates.txt"),
    routes: readGtfsFile(zip, "routes.txt"),
    stopTimes: readGtfsFile(zip, "stop_times.txt"),
    stops: readGtfsFile(zip, "stops.txt"),
    trips: readGtfsFile(zip, "trips.txt"),
  };
  return gtfsCache;
}

async function getRealtimeDepartures() {
  const response = await fetch(GTFS_RT_TRIP_UPDATES_URL);
  if (!response.ok) {
    throw new Error(`GTFS-RT request failed (${response.status}): ${response.statusText}`);
  }

  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
    new Uint8Array(await response.arrayBuffer()),
  );
  const gtfs = await getGtfsData();
  const tripsById = new Map(gtfs.trips.map((trip) => [trip.trip_id, trip]));
  const routesById = new Map(gtfs.routes.map((route) => [route.route_id, route]));
  const now = Date.now();

  return feed.entity
    .filter((entity) => entity.tripUpdate?.trip?.tripId)
    .flatMap((entity) => {
      const tripUpdate = entity.tripUpdate;
      const tripId = tripUpdate.trip.tripId;
      const trip = tripsById.get(tripId);
      return tripUpdate.stopTimeUpdate
        .filter((stopTimeUpdate) => stopTimeUpdate.stopId === STOP_ID)
        .map((stopTimeUpdate) => {
          const timestamp = stopTimeUpdate.departure?.time || stopTimeUpdate.arrival?.time;
          if (!timestamp) return null;

          const departureTime = Number(timestamp.toString()) * 1000;
          const routeId = tripUpdate.trip.routeId || trip?.route_id;
          const route = routesById.get(routeId);
          return {
            headsign: trip?.trip_headsign || tripUpdate.trip.routeId || "Unknown destination",
            route: {
              shortName: route?.route_short_name || routeId,
              name: route?.route_long_name,
            },
            directionId: trip?.direction_id,
            scheduledDeparture: new Date(departureTime).toISOString(),
            estimatedDeparture: new Date(departureTime).toISOString(),
          };
        })
        .filter((departure) => {
          if (!departure) return false;
          const minutes = (new Date(departure.estimatedDeparture).getTime() - now) / 60000;
          return minutes >= 0 && minutes <= PREVIEW_MINUTES;
        });
    })
    .sort((a, b) => new Date(a.estimatedDeparture) - new Date(b.estimatedDeparture));
}

function serviceRunsToday(serviceId, date, calendar, calendarDates) {
  const dateString = date.toISOString().slice(0, 10).replaceAll("-", "");
  const exception = calendarDates.find(
    (row) => row.service_id === serviceId && row.date === dateString,
  );
  if (exception) return exception.exception_type === "1";

  const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][
    date.getDay()
  ];
  const service = calendar.find(
    (row) => row.service_id === serviceId
      && row.start_date <= dateString
      && row.end_date >= dateString,
  );
  return service?.[weekday] === "1";
}

function getScheduledDepartures(data, now = new Date()) {
  const stop = data.stops.find((row) => row.stop_id === STOP_ID);
  if (!stop) throw new Error(`GTFS feed does not contain stop ${STOP_ID}.`);

  const date = new Date(now);
  const currentSeconds = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
  const activeServices = new Set(
    data.calendar
      .filter((row) => serviceRunsToday(row.service_id, date, data.calendar, data.calendarDates))
      .map((row) => row.service_id),
  );
  for (const exception of data.calendarDates) {
    if (serviceRunsToday(exception.service_id, date, data.calendar, data.calendarDates)) {
      activeServices.add(exception.service_id);
    }
  }

  const tripsById = new Map(
    data.trips
      .filter((trip) => activeServices.has(trip.service_id))
      .map((trip) => [trip.trip_id, trip]),
  );
  return data.stopTimes
    .filter((row) => row.stop_id === stop.stop_id && tripsById.has(row.trip_id))
    .map((row) => {
      const [hours, minutes, seconds] = row.departure_time.split(":").map(Number);
      const departureSeconds = hours * 3600 + minutes * 60 + seconds;
      const trip = tripsById.get(row.trip_id);
      const route = data.routes.find((item) => item.route_id === trip.route_id);
      return {
        headsign: trip.trip_headsign || "Scheduled trip",
        route: {
          shortName: route?.route_short_name || trip.route_id,
          name: route?.route_long_name,
        },
        directionId: trip.direction_id,
        scheduledDeparture: new Date(
          date.getTime() + (departureSeconds - currentSeconds) * 1000,
        ).toISOString(),
      };
    })
    .filter((departure) => {
      const minutes = (new Date(departure.scheduledDeparture).getTime() - now.getTime()) / 60000;
      return minutes >= 0 && minutes <= PREVIEW_MINUTES;
    })
    .sort((a, b) => new Date(a.scheduledDeparture) - new Date(b.scheduledDeparture));
}

function routeName(departure) {
  const headsignDirection = departure.headsign?.match(/^(North|South|East|West)\b/i)?.[1];
  const direction = headsignDirection
    ? headsignDirection[0].toUpperCase()
    : departure.directionId === "0"
      ? "N"
      : departure.directionId === "1"
        ? "S"
        : "";
  return `${departure.route?.shortName
    || departure.route?.name
    || departure.trip?.route?.shortName
    || departure.trip?.route?.name
    || "Unknown route"}${direction}`;
}

function arrivalTime(departure) {
  if (departure.estimatedDeparture) {
    const minutes = Math.round(
      (new Date(departure.estimatedDeparture).getTime() - Date.now()) / 60000,
    );
    return minutes <= 0 ? "Due" : `${minutes} min`;
  }

  if (departure.scheduledDeparture) {
    return new Date(departure.scheduledDeparture).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  return "Unknown";
}

export function formatDisplay(departures, now = new Date()) {
  const width = 64;
  const border = `+${"-".repeat(width)}+`;
  const time = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const fit = (value) => value.slice(0, width - 2).padEnd(width - 2);
  const lines = [
    border,
    `|${fit(` MTD  ${STOP_NAME.toUpperCase()}`)}|`,
    `|${fit(` NEXT DEPARTURES                              ${time}`)}|`,
    border,
  ];

  if (departures.length === 0) {
    lines.push(`|${fit(" NO DEPARTURES IN THE NEXT HOUR")}|`);
    lines.push(border);
    return lines.join("\n");
  }

  for (const departure of departures) {
    const destination = departure.headsign || departure.trip?.direction?.name || "Unknown destination";
    const route = routeName(departure);
    lines.push(`|${fit(` ${route}  >  ${destination}`)}|`);
    lines.push(`|${fit(`   ${arrivalTime(departure).toUpperCase()}`)}|`);
  }

  lines.push(border);
  return lines.join("\n");
}

async function displayOnce() {
  process.stdout.write("\x1b[2J\x1b[H");
  try {
    const departures = await getRealtimeDepartures();
    console.log(formatDisplay(departures));
    return true;
  } catch (error) {
    console.error(`GTFS-RT data unavailable: ${error.message}`);
    try {
      const departures = await getDepartures();
      console.log(formatDisplay(departures));
      return true;
    } catch (apiError) {
      console.error(`MTD API data unavailable: ${apiError.message}`);
      try {
        const scheduled = getScheduledDepartures(await getGtfsData());
        console.log(formatDisplay(scheduled));
        return true;
      } catch (fallbackError) {
        console.error(`GTFS fallback unavailable: ${fallbackError.message}`);
        console.log(`${STOP_NAME}\nService data temporarily unavailable.`);
        return false;
      }
    }
  }
}

const once = process.argv.includes("--once");

try {
  if (once) {
    if (!(await displayOnce())) {
      process.exitCode = 1;
    }
  } else {
    await displayOnce();
    setInterval(() => {
      void displayOnce();
    }, POLL_INTERVAL_MS);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
