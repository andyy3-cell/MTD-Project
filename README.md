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

The app uses MTD API v3 and sends the key in the `X-ApiKey` header. It is
intentionally polled no more than once per minute. For a single request while testing:

```sh
npm run once
```

Optional settings:

```env
MTD_STOP_ID=5THARY:3
MTD_PREVIEW_MINUTES=60
MTD_POLL_INTERVAL_SECONDS=60
```