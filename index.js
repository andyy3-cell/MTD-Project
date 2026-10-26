import "dotenv/config";

const apiKey = process.env.MTD_API_KEY;

if (!apiKey) {
  throw new Error("MTD_API_KEY is missing");
}

const url =
  `https://developer.mtd.org/api/v2.2/json/getroutes?key=${encodeURIComponent(apiKey)}`;

const response = await fetch(url);

if (!response.ok) {
  throw new Error(`MTD API request failed: ${response.status}`);
}

const data = await response.json();
console.log(data);
