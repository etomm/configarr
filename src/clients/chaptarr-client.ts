import type { RemotePathMappingResource } from "../__generated__/readarr/data-contracts";
import { ReadarrClient } from "./readarr-client";

/** Chaptarr adds a required client id to the Readarr remote path mapping shape. */
type ChaptarrRemotePathMappingResource = RemotePathMappingResource & { downloadClientId: number };

/** Chaptarr keeps Readarr's API surface; only the diagnostics label differs. */
export class ChaptarrClient extends ReadarrClient {
  constructor(baseUrl: string, apiKey: string) {
    super(baseUrl, apiKey, "CHAPTARR");
  }

  // Chaptarr requires a download client id on the mapping resource, even when the
  // mapping is global. Zero is accepted and keeps the mapping unattached.
  override async createRemotePathMapping(mapping: RemotePathMappingResource): Promise<RemotePathMappingResource> {
    const payload: ChaptarrRemotePathMappingResource = { ...mapping, downloadClientId: 0 };
    return super.createRemotePathMapping(payload);
  }

  override async updateRemotePathMapping(id: string, mapping: RemotePathMappingResource): Promise<RemotePathMappingResource> {
    const payload: ChaptarrRemotePathMappingResource = { ...mapping, downloadClientId: 0 };
    return super.updateRemotePathMapping(id, payload);
  }
}
