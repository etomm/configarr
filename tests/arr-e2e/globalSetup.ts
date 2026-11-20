import type { TestProject } from "vitest/node";
import { setupRunRepos, waitForAllArrApis, waitForArrApi, waitForSonarrApi } from "./helpers";

/**
 * Runs once per vitest project: its containers answer, and it gets its own snapshot of the
 * Recyclarr / TRaSH clone so its test files copy that instead of cloning.
 * Version projects set `<ARR>_BASE_URL` in `test.env` and only wait for that container.
 */
export default async function setup(project: TestProject): Promise<() => void> {
  const env = project.config.env ?? {};
  if (env.SONARR_BASE_URL) {
    await waitForSonarrApi(env.SONARR_BASE_URL, env.SONARR_API_KEY ?? "");
  } else if (env.RADARR_BASE_URL) {
    await waitForArrApi(env.RADARR_BASE_URL, env.RADARR_API_KEY ?? "", "/api/v3/system/status");
  } else if (env.READARR_BASE_URL ?? process.env.READARR_BASE_URL) {
    await waitForArrApi(
      env.READARR_BASE_URL ?? process.env.READARR_BASE_URL ?? "",
      env.READARR_API_KEY ?? process.env.READARR_API_KEY ?? "",
      "/api/v1/system/status",
    );
  } else if (env.CHAPTARR_BASE_URL ?? process.env.CHAPTARR_BASE_URL) {
    await waitForArrApi(
      env.CHAPTARR_BASE_URL ?? process.env.CHAPTARR_BASE_URL ?? "",
      env.CHAPTARR_API_KEY ?? process.env.CHAPTARR_API_KEY ?? "",
      "/api/v1/system/status",
    );
  } else if (env.PROWLARR_BASE_URL ?? process.env.PROWLARR_BASE_URL) {
    await waitForArrApi(
      env.PROWLARR_BASE_URL ?? process.env.PROWLARR_BASE_URL ?? "",
      env.PROWLARR_API_KEY ?? process.env.PROWLARR_API_KEY ?? "",
      "/api/v1/system/status",
    );
  } else {
    await waitForAllArrApis();
  }
  return await setupRunRepos(project);
}
