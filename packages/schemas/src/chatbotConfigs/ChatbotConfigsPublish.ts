import type { ModelProviderEnum } from "../companySecrets/CompanySecretsCommon";
import type { ConfigSpecBody } from "../configSpec/ConfigSpecRegistry";
import { getModelPrice } from "../modelRouter/ModelRouterCommon";
import type { ChatbotConfigPin } from "./ChatbotConfigsApiResponse";

const ROUTING_TIERS = ["small", "mid", "top"] as const;

export interface ChatbotConfigPublishNeeds {
  // Every provider a routing tier uses, once each, in tier order: each needs an Active model key
  providers: ModelProviderEnum[];
  // "<provider>/<model>" of each tier the router can't price (it would refuse every call: ModelNotPriced)
  unpricedModels: string[];
  // The exact tool versions the config pins: each must be Active
  pins: ChatbotConfigPin[];
}

// DEV_NOTE: What a version needs from the company before it can be published (M4-10). Pure, so the editor shows the same
// warnings the publish refuses with; the Repo checks the keys and pins in the database under its locks.
export function getChatbotConfigPublishNeeds(body: ConfigSpecBody): ChatbotConfigPublishNeeds {
  const providers: ModelProviderEnum[] = [];
  const unpricedModels: string[] = [];
  for (const tier of ROUTING_TIERS) {
    const { provider, model } = body.routing[tier];
    if (!providers.includes(provider)) providers.push(provider);
    const label = `${provider}/${model}`;
    if (getModelPrice(provider, model) === null && !unpricedModels.includes(label)) {
      unpricedModels.push(label);
    }
  }
  return {
    providers,
    unpricedModels,
    pins: body.tools.map((tool) => ({ name: tool.name, version: tool.version })),
  };
}
