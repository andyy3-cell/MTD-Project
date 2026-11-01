import "dotenv/config";

const API_BASE_URL = "https://api.mtd.dev";
const STOP_ID = process.env.MTD_STOP_ID || "5THARY:3";
const STOP_NAME = "5 Fifth & Armory (SW Corner)";
const PREVIEW_MINUTES = Number(process.env.MTD_PREVIEW_MINUTES || 60);
const POLL_INTERVAL_MS = Number(process.env.MTD_POLL_INTERVAL_SECONDS || 60) * 1000;

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

  const response = await fetch(url, {
    headers: {
      "X-ApiKey": getApiKey(),
    },
  });
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message = data?.error?.message || data?.message || response.statusText;
    throw new Error(`MTD API request failed (${response.status}): ${message}`);
  }

  if (!Array.isArray(data?.result)) {
    throw new Error("MTD API response did not contain a result array.");
  }

  return data.result;
}

function routeName(departure) {
  return departure.route?.shortName
    || departure.route?.name
    || departure.trip?.route?.shortName
    || departure.trip?.route?.name
    || "Unknown route";
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
  const lines = [
    STOP_NAME,
    `Stop ${STOP_ID} | ${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
    "------------------------------",
  ];

  if (departures.length === 0) {
    lines.push("No buses in the next hour.");
    return lines.join("\n");
  }

  for (const departure of departures) {
    const destination = departure.headsign || departure.trip?.direction?.name || "Unknown destination";
    const monitored = departure.estimatedDeparture ? " live" : "";
    lines.push(`${routeName(departure).padEnd(8)} ${arrivalTime(departure).padEnd(8)} ${destination}${monitored}`);
  }

  return lines.join("\n");
}

async function displayOnce() {
  const departures = await getDepartures();
  process.stdout.write("\x1b[2J\x1b[H");
  console.log(formatDisplay(departures));
}

const once = process.argv.includes("--once");

try {
  if (once) {
    await displayOnce();
  } else {
    await displayOnce();
    setInterval(() => {
      displayOnce().catch((error) => {
        console.error(`Unable to update display: ${error.message}`);
      });
    }, POLL_INTERVAL_MS);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
