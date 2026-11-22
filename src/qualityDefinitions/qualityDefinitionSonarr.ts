import type { QualityDefinitionResource } from "../__generated__/sonarr/data-contracts";
import type { QualityDefinitionsClient } from "../clients/capabilities";
import type { SonarrClient } from "../clients/sonarr-client";
import { logger } from "../logger";
import { QualityDefinitionPreferredSync } from "./qualityDefinition";
import type { QualityDefinitionQuality } from "./qualityDefinition.types";

type SonarrQualityDefinitionClient = QualityDefinitionsClient<QualityDefinitionResource> &
  Pick<SonarrClient, "supportsProfileQualitySizes">;

const profileSizeFields = new Set(["minSize", "preferredSize", "maxSize"]);

export class QualityDefinitionSonarrSync extends QualityDefinitionPreferredSync<QualityDefinitionResource> {
  constructor(private readonly sonarrClient: SonarrQualityDefinitionClient) {
    super(sonarrClient);
  }

  async persist(serverDefinitions: QualityDefinitionResource[], configuredDefinitions: QualityDefinitionQuality[], write: boolean) {
    if (!(await this.sonarrClient.supportsProfileQualitySizes())) {
      return super.persist(serverDefinitions, configuredDefinitions, write);
    }

    // v5 keeps sizes on profile items. A QD PUT that carries sizes is silently ignored
    // by the API, so report the limitation instead of pretending the global write worked.
    if (
      configuredDefinitions.some(
        (definition) => definition.min !== undefined || definition.preferred !== undefined || definition.max !== undefined,
      )
    ) {
      logger.warn(
        "QualityDefinition: sizes in 'quality_definition' are ignored on Sonarr v5 (sizes live on profile items); set 'quality_sizes' on the quality profile instead.",
      );
    }

    const { changeMap, restData } = this.calculateDiff(serverDefinitions, configuredDefinitions);
    for (const [name, changes] of changeMap) {
      const remainingChanges = changes.filter((change) => !profileSizeFields.has(change.field));
      if (remainingChanges.length === 0) {
        changeMap.delete(name);
      } else {
        changeMap.set(name, remainingChanges);
      }
    }

    if (changeMap.size > 0 && write) {
      return { changeMap, restData: await this.updateOnServer(restData) };
    }
    return { changeMap, restData };
  }
}
