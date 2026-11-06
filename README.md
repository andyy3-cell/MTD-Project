# MTD bus display

This Node.js app displays upcoming departures for **5 Fifth & Armory (SW Corner)**,
then refreshes them every minute. The v3 stop ID is `5THARY:3`.

## Setup

1. Get an API key from the [MTD developer portal](https://mtd.dev/account/).
2. Create `.env`:

   ```env
   MTD_API_KEY=your_api_key
   ```

3. Run the display:

   ```sh
   npm start
   ```

The app uses the official MTD GTFS-RT trip updates feed for live departures and
is intentionally polled no more than once per minute. If GTFS-RT is unavailable,
it tries MTD API v3, then the official GTFS schedule feed. Temporary server
errors from the API are retried up to two times. For a single request while
testing:

```sh
npm run once
```

Optional settings:

```env
MTD_STOP_ID=5THARY:3
MTD_PREVIEW_MINUTES=60
MTD_POLL_INTERVAL_SECONDS=60
```