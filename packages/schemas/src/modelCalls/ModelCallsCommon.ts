export enum ModelCallTierIntEnum {
  Small = 1,
  Mid = 2,
  Top = 3,
  Embed = 4,
}

export enum ModelCallTierLabelEnum {
  Small = "Small",
  Mid = "Mid",
  Top = "Top",
  Embed = "Embed",
}

export const MODEL_CALL_TIER_LABEL_MAP: Record<ModelCallTierIntEnum, ModelCallTierLabelEnum> = {
  [ModelCallTierIntEnum.Small]: ModelCallTierLabelEnum.Small,
  [ModelCallTierIntEnum.Mid]: ModelCallTierLabelEnum.Mid,
  [ModelCallTierIntEnum.Top]: ModelCallTierLabelEnum.Top,
  [ModelCallTierIntEnum.Embed]: ModelCallTierLabelEnum.Embed,
};
