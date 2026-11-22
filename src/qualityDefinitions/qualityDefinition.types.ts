export type QualityDefinitionSizeValue = number | null;

/**
 * Internal quality-definition shape shared by TRaSH data and user config. Sizes are
 * optional because an absent field means "unmanaged"; `null` is an explicit clear
 * (unlimited), which is why the two cannot be collapsed into one type.
 */
export type QualityDefinitionQuality = {
  quality: string;
  title?: string;
  min?: QualityDefinitionSizeValue;
  preferred?: QualityDefinitionSizeValue;
  max?: QualityDefinitionSizeValue;
};

export type QualityDefinitionShared = {
  id?: number;
  title?: string | null;
  weight?: number;
  minSize?: number | null;
  maxSize?: number | null;
  preferredSize?: number | null;
  quality?: {
    id?: number;
    name?: string | null;
    resolution?: number;
  };
};
