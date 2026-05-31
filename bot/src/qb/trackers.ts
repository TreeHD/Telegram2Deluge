import { logger } from "../config.js";

const TRACKERS_URL = "https://raw.githubusercontent.com/ngosang/trackerslist/refs/heads/master/trackers_all.txt";
const UPDATE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

let cachedTrackers: string[] = [];

export async function fetchTrackers(): Promise<string[]> {
  try {
    const res = await fetch(TRACKERS_URL);
    const text = await res.text();
    cachedTrackers = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    logger.info({ count: cachedTrackers.length }, "Trackers list updated");
    return cachedTrackers;
  } catch (err) {
    logger.error(err, "Failed to fetch trackers list");
    return cachedTrackers;
  }
}

export function getTrackers(): string[] {
  return cachedTrackers;
}

export function startTrackerUpdater() {
  fetchTrackers();
  setInterval(fetchTrackers, UPDATE_INTERVAL);
}
