import { useEffect, useState } from "react";
import type { PropsWithChildren } from "react";
import { Link } from "@tanstack/react-router";
import { useForm, useStore } from "@tanstack/react-form";
import { Plus, X } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Alert, AlertDescription, AlertTitle } from "@app/ui/components/alert";
import { Button } from "@app/ui/components/button";
import { Checkbox } from "@app/ui/components/checkbox";
import { Field, FieldDescription, FieldLabel } from "@app/ui/components/field";
import { Input } from "@app/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@app/ui/components/select";
import { Textarea } from "@app/ui/components/textarea";
import {
  APPROVAL_LABELS,
  CONFIG_LIMIT_FIELDS,
  CONFIG_SUGGESTION_SLOTS,
  MODEL_TIERS,
  MODEL_TIER_LABELS,
  checkConfigBody,
  isRuleOrphaned,
  toConfigBodyInput,
} from "./-configForm";

const PROVIDERS = Object.values(Schemas.ModelProviderEnum);
const APPROVALS = Object.values(Schemas.ApprovalRuleApprovalEnum);
const pinKey = (pin: Schemas.ChatbotConfigPin) => `${pin.name}@${pin.version}`;
// DEV_NOTE: The widget's suggestion inputs: fixed slots (the form always holds CONFIG_SUGGESTION_SLOTS of them)
const SUGGESTION_SLOTS = Array.from(
  { length: CONFIG_SUGGESTION_SLOTS },
  (_, index) => `suggestion-${index + 1}`,
);

// DEV_NOTE: One block of the config (a bordered box with a heading and a line on what it does)
function ConfigSection({
  title,
  description,
  children,
}: PropsWithChildren<Schemas.DashboardConfigSectionProps>) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border px-[22px] py-5" aria-label={title}>
      <div className="flex flex-col gap-0.5">
        <h2 className="text-section text-foreground">{title}</h2>
        {description && <p className="text-caption text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

// DEV_NOTE: The draft editor (M4-10), one section per config block. Every field is the company's own value: an empty
// number keeps the platform default (shown as the placeholder). On save the whole form becomes a body, checked here with
// the config spec (issues listed above the buttons) and again by the backend. A version that isn't a draft shows the same
// form read-only.
export function ConfigForm({
  defaultValues,
  attachments,
  options,
  isEditable,
  isNew,
  onSave,
  onDirtyChange,
}: Schemas.DashboardConfigFormProps) {
  const [issues, setIssues] = useState<string[]>([]);
  // DEV_NOTE: One stable key per list row, added and removed with it, so inputs keep their focus and state
  const [procedureKeys, setProcedureKeys] = useState(() =>
    defaultValues.procedures.map(() => crypto.randomUUID()),
  );
  const [ruleKeys, setRuleKeys] = useState(() =>
    defaultValues.approvalRules.map(() => crypto.randomUUID()),
  );
  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      const checked = checkConfigBody(toConfigBodyInput(value, attachments));
      setIssues(checked.issues);
      if (!checked.body) return;
      await onSave(checked.body);
      form.reset(value);
    },
  });
  const isDirty = useStore(form.store, (state) => state.isDirty);
  useEffect(() => onDirtyChange(isDirty), [isDirty, onDirtyChange]);

  const sourceNames = new Map(
    options.knowledgeSources.map((source) => [source.publicId, source.name]),
  );
  const toolOptionKeys = new Set(options.tools.map(pinKey));

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit().catch(() => undefined);
      }}
    >
      <fieldset disabled={!isEditable} className="flex min-w-0 flex-col gap-6">
        <ConfigSection
          title="Instructions"
          description="What the assistant is for and how it talks. This is the only text it treats as instructions."
        >
          <form.Field name="instructions">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="config-instructions" className="sr-only">
                  Instructions
                </FieldLabel>
                <Textarea
                  id="config-instructions"
                  name={field.name}
                  rows={8}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
        </ConfigSection>

        <ConfigSection
          title="Procedures"
          description="Named playbooks the assistant follows when one fits the request."
        >
          <form.Field name="procedures" mode="array">
            {(proceduresField) => (
              <div className="flex flex-col gap-4">
                {proceduresField.state.value.length === 0 && (
                  <p className="text-body text-muted-foreground">No procedures.</p>
                )}
                {proceduresField.state.value.map((_, index) => (
                  <div
                    key={procedureKeys[index]}
                    className="flex flex-col gap-3 rounded-lg bg-surface-subtle p-4"
                  >
                    <div className="flex items-start gap-2">
                      <form.Field name={`procedures[${index}].name`}>
                        {(field) => (
                          <Field className="flex-1">
                            <FieldLabel htmlFor={`procedure-name-${index}`}>Name</FieldLabel>
                            <Input
                              id={`procedure-name-${index}`}
                              value={field.state.value}
                              onBlur={field.handleBlur}
                              onChange={(event) => field.handleChange(event.target.value)}
                            />
                          </Field>
                        )}
                      </form.Field>
                      {isEditable && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="mt-6 text-subtle-foreground"
                          aria-label={`Remove procedure ${index + 1}`}
                          onClick={() => {
                            proceduresField.removeValue(index);
                            setProcedureKeys((keys) => keys.filter((_, at) => at !== index));
                          }}
                        >
                          <X />
                        </Button>
                      )}
                    </div>
                    <form.Field name={`procedures[${index}].whenToUse`}>
                      {(field) => (
                        <Field>
                          <FieldLabel htmlFor={`procedure-when-${index}`}>
                            When to use it
                          </FieldLabel>
                          <Input
                            id={`procedure-when-${index}`}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                          />
                        </Field>
                      )}
                    </form.Field>
                    <form.Field name={`procedures[${index}].steps`}>
                      {(field) => (
                        <Field>
                          <FieldLabel htmlFor={`procedure-steps-${index}`}>Steps</FieldLabel>
                          <Textarea
                            id={`procedure-steps-${index}`}
                            rows={3}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                          />
                        </Field>
                      )}
                    </form.Field>
                  </div>
                ))}
                {isEditable && (
                  <Button
                    type="button"
                    variant="outline"
                    className="self-start"
                    onClick={() => {
                      proceduresField.pushValue({ name: "", whenToUse: "", steps: "" });
                      setProcedureKeys((keys) => [...keys, crypto.randomUUID()]);
                    }}
                  >
                    <Plus aria-hidden />
                    Add procedure
                  </Button>
                )}
              </div>
            )}
          </form.Field>
        </ConfigSection>

        <ConfigSection
          title="Tools"
          description="The tool versions this bot may use. Only turned-on versions can be published."
        >
          <form.Field name="tools">
            {(field) => {
              const pinned = field.state.value;
              const isPinned = (pin: Schemas.ChatbotConfigPin) =>
                pinned.some((tool) => pinKey(tool) === pinKey(pin));
              const toggle = (pin: Schemas.ChatbotConfigPin, isOn: boolean) =>
                field.handleChange(
                  isOn
                    ? [...pinned.filter((tool) => tool.name !== pin.name), pin]
                    : pinned.filter((tool) => pinKey(tool) !== pinKey(pin)),
                );
              const unavailable = pinned.filter((tool) => !toolOptionKeys.has(pinKey(tool)));
              return (
                <div className="flex flex-col gap-3">
                  {options.tools.length === 0 && unavailable.length === 0 && (
                    <p className="text-body text-muted-foreground">
                      No tools are turned on for your company yet.
                    </p>
                  )}
                  {options.tools.map((tool) => (
                    <label key={pinKey(tool)} className="flex items-start gap-3">
                      <Checkbox
                        className="mt-0.5"
                        checked={isPinned(tool)}
                        onCheckedChange={(checked) => toggle(tool, checked === true)}
                      />
                      <span className="flex flex-col gap-0.5">
                        <span className="text-body text-foreground">
                          <span className="font-mono text-mono-value">{tool.name}</span>{" "}
                          <span className="font-mono text-mono-value text-muted-foreground">
                            v{tool.version}
                          </span>{" "}
                          <span className="text-caption text-muted-foreground">
                            · {tool.riskLabel}
                          </span>
                        </span>
                        <span className="text-caption text-muted-foreground">
                          {tool.description}
                        </span>
                      </span>
                    </label>
                  ))}
                  {unavailable.map((tool) => (
                    <label key={pinKey(tool)} className="flex items-start gap-3">
                      <Checkbox
                        className="mt-0.5"
                        checked
                        onCheckedChange={(checked) => toggle(tool, checked === true)}
                      />
                      <span className="text-body text-foreground">
                        <span className="font-mono text-mono-value">{tool.name}</span>{" "}
                        <span className="font-mono text-mono-value text-muted-foreground">
                          v{tool.version}
                        </span>{" "}
                        <span className="text-caption text-destructive">· Not turned on</span>
                      </span>
                    </label>
                  ))}
                </div>
              );
            }}
          </form.Field>
        </ConfigSection>

        <ConfigSection
          title="Approval rules"
          description="Checked in order for tools set to follow the rules; the first match wins, and no match means the user approves. Destructive changes, and turns that read outside content, always need approval."
        >
          <form.Subscribe selector={(state) => state.values.tools}>
            {(pinnedTools) => (
              <form.Field name="approvalRules" mode="array">
                {(rulesField) => (
                  <div className="flex flex-col gap-4">
                    {rulesField.state.value.length === 0 && (
                      <p className="text-body text-muted-foreground">
                        No rules: every change waits for the user's approval.
                      </p>
                    )}
                    {rulesField.state.value.map((_, index) => (
                      <div
                        key={ruleKeys[index]}
                        className="flex flex-col gap-3 rounded-lg bg-surface-subtle p-4"
                      >
                        <div className="flex flex-wrap items-start gap-3">
                          <form.Field name={`approvalRules[${index}].roles`}>
                            {(field) => (
                              <Field className="min-w-52 flex-1">
                                <FieldLabel htmlFor={`rule-roles-${index}`}>Roles</FieldLabel>
                                <Input
                                  id={`rule-roles-${index}`}
                                  placeholder="Any role"
                                  value={field.state.value}
                                  onBlur={field.handleBlur}
                                  onChange={(event) => field.handleChange(event.target.value)}
                                />
                                <FieldDescription>
                                  From the user's sign-in token, separated by commas.
                                </FieldDescription>
                              </Field>
                            )}
                          </form.Field>
                          <form.Field name={`approvalRules[${index}].approval`}>
                            {(field) => (
                              <Field className="w-56">
                                <FieldLabel htmlFor={`rule-approval-${index}`}>Then</FieldLabel>
                                <Select
                                  value={field.state.value}
                                  onValueChange={(value) =>
                                    field.handleChange(value as Schemas.ApprovalRuleApprovalEnum)
                                  }
                                >
                                  <SelectTrigger id={`rule-approval-${index}`} className="w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {APPROVALS.map((approval) => (
                                      <SelectItem key={approval} value={approval}>
                                        {APPROVAL_LABELS[approval]}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </Field>
                            )}
                          </form.Field>
                          {isEditable && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="mt-6 text-subtle-foreground"
                              aria-label={`Remove rule ${index + 1}`}
                              onClick={() => {
                                rulesField.removeValue(index);
                                setRuleKeys((keys) => keys.filter((_, at) => at !== index));
                              }}
                            >
                              <X />
                            </Button>
                          )}
                        </div>
                        <form.Field name={`approvalRules[${index}].tools`}>
                          {(field) => (
                            <div className="flex flex-col gap-2">
                              <p className="text-body font-medium text-foreground">Tools</p>
                              {pinnedTools.length === 0 && (
                                <p className="text-caption text-muted-foreground">
                                  Every tool (none is chosen above).
                                </p>
                              )}
                              <div className="flex flex-wrap gap-x-5 gap-y-2">
                                {pinnedTools.map((tool) => (
                                  <label key={tool.name} className="flex items-center gap-2">
                                    <Checkbox
                                      checked={field.state.value.includes(tool.name)}
                                      onCheckedChange={(checked) =>
                                        field.handleChange(
                                          checked === true
                                            ? [...field.state.value, tool.name]
                                            : field.state.value.filter(
                                                (name) => name !== tool.name,
                                              ),
                                        )
                                      }
                                    />
                                    <span className="font-mono text-mono-value text-foreground">
                                      {tool.name}
                                    </span>
                                  </label>
                                ))}
                              </div>
                              {isRuleOrphaned(
                                field.state.value,
                                pinnedTools.map((tool) => tool.name),
                              ) ? (
                                <p className="text-caption text-destructive">
                                  This rule only named tools you removed. Tick a tool or delete the
                                  rule; it isn't saved as a rule for every tool.
                                </p>
                              ) : (
                                pinnedTools.length > 0 && (
                                  <FieldDescription>None ticked means every tool.</FieldDescription>
                                )
                              )}
                            </div>
                          )}
                        </form.Field>
                      </div>
                    ))}
                    {isEditable && (
                      <Button
                        type="button"
                        variant="outline"
                        className="self-start"
                        onClick={() => {
                          rulesField.pushValue({
                            roles: "",
                            tools: [],
                            approval: Schemas.ApprovalRuleApprovalEnum.Required,
                          });
                          setRuleKeys((keys) => [...keys, crypto.randomUUID()]);
                        }}
                      >
                        <Plus aria-hidden />
                        Add rule
                      </Button>
                    )}
                  </div>
                )}
              </form.Field>
            )}
          </form.Subscribe>
        </ConfigSection>

        <ConfigSection
          title="Models"
          description="Every call uses your own key for the provider. Each tier's model must be one we can price."
        >
          <div className="flex flex-col gap-4">
            {MODEL_TIERS.map((tier) => (
              <form.Field key={tier} name={`routing.${tier}`}>
                {(field) => {
                  const { provider, model } = field.state.value;
                  const models = Object.keys(Schemas.MODEL_PRICES[provider]);
                  const hasKey = options.activeKeyProviders.includes(provider);
                  return (
                    <div className="flex flex-col gap-1.5">
                      <div className="grid gap-3 sm:grid-cols-[8rem_1fr_1fr] sm:items-center">
                        <p className="text-body font-medium text-foreground">
                          {MODEL_TIER_LABELS[tier]}
                        </p>
                        <Select
                          value={provider}
                          onValueChange={(value) => {
                            const next = value as Schemas.ModelProviderEnum;
                            field.handleChange({
                              provider: next,
                              model: Schemas.MODEL_TIER_SUGGESTIONS[next][tier],
                            });
                          }}
                        >
                          <SelectTrigger
                            className="w-full"
                            aria-label={`${MODEL_TIER_LABELS[tier]} provider`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PROVIDERS.map((option) => (
                              <SelectItem key={option} value={option}>
                                {Schemas.MODEL_PROVIDER_LABEL_MAP[option]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={model}
                          onValueChange={(value) => field.handleChange({ provider, model: value })}
                        >
                          <SelectTrigger
                            className="w-full font-mono"
                            aria-label={`${MODEL_TIER_LABELS[tier]} model`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(models.includes(model) ? models : [model, ...models]).map(
                              (option) => (
                                <SelectItem key={option} value={option} className="font-mono">
                                  {option}
                                </SelectItem>
                              ),
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                      {!hasKey && (
                        <p className="text-caption text-warning sm:pl-[8.75rem]">
                          No working {Schemas.MODEL_PROVIDER_LABEL_MAP[provider]} key.{" "}
                          <Link to="/settings/model-keys" className="underline">
                            Add one
                          </Link>{" "}
                          before publishing.
                        </p>
                      )}
                    </div>
                  );
                }}
              </form.Field>
            ))}
            <form.Field name="routing.defaultTier">
              {(field) => (
                <Field className="sm:max-w-80">
                  <FieldLabel htmlFor="config-default-tier">Default tier</FieldLabel>
                  <Select
                    value={field.state.value}
                    onValueChange={(value) => field.handleChange(value as Schemas.ModelTierEnum)}
                  >
                    <SelectTrigger id="config-default-tier" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODEL_TIERS.map((tier) => (
                        <SelectItem key={tier} value={tier}>
                          {MODEL_TIER_LABELS[tier]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>The tier the assistant answers with.</FieldDescription>
                </Field>
              )}
            </form.Field>
          </div>
        </ConfigSection>

        <ConfigSection
          title="Knowledge"
          description="The sources the assistant searches to answer. None ticked means it searches nothing."
        >
          <form.Field name="sourceIds">
            {(field) => {
              const chosen = field.state.value;
              const removed = chosen.filter((publicId) => !sourceNames.has(publicId));
              const toggle = (publicId: string, isOn: boolean) =>
                field.handleChange(
                  isOn ? [...chosen, publicId] : chosen.filter((id) => id !== publicId),
                );
              return (
                <div className="flex flex-col gap-3">
                  {options.knowledgeSources.length === 0 && removed.length === 0 && (
                    <p className="text-body text-muted-foreground">
                      No knowledge sources yet.{" "}
                      <Link to="/knowledge" className="underline">
                        Add one
                      </Link>{" "}
                      on the Knowledge page.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    {options.knowledgeSources.map((source) => (
                      <label key={source.publicId} className="flex items-center gap-2">
                        <Checkbox
                          checked={chosen.includes(source.publicId)}
                          onCheckedChange={(checked) => toggle(source.publicId, checked === true)}
                        />
                        <span className="text-body text-foreground">{source.name}</span>
                      </label>
                    ))}
                    {removed.map((publicId) => (
                      <label key={publicId} className="flex items-center gap-2">
                        <Checkbox
                          checked
                          onCheckedChange={(checked) => toggle(publicId, checked === true)}
                        />
                        <span className="text-body text-muted-foreground">Removed source</span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            }}
          </form.Field>
          <form.Field name="topK">
            {(field) => (
              <Field className="sm:max-w-80">
                <FieldLabel htmlFor="config-top-k">Results per search</FieldLabel>
                <Input
                  id="config-top-k"
                  inputMode="numeric"
                  placeholder={String(Schemas.CONFIG_SPEC_PLATFORM_DEFAULTS.knowledgeTopK)}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldDescription>Leave empty for the default.</FieldDescription>
              </Field>
            )}
          </form.Field>
        </ConfigSection>

        <ConfigSection title="Widget" description="What the user sees before they ask anything.">
          <form.Field name="greeting">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="config-greeting">Greeting</FieldLabel>
                <Input
                  id="config-greeting"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <div className="flex flex-col gap-2">
            <p className="text-body font-medium text-foreground">Suggestions</p>
            {SUGGESTION_SLOTS.map((slot, index) => (
              <form.Field key={slot} name={`suggestions[${index}]`}>
                {(field) => (
                  <Input
                    aria-label={`Suggestion ${index + 1}`}
                    placeholder="Optional"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                )}
              </form.Field>
            ))}
          </div>
          <form.Field name="launcherLabel">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="config-launcher">Launcher label</FieldLabel>
                <Input
                  id="config-launcher"
                  placeholder="Optional"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldDescription>Shown next to the chat button.</FieldDescription>
              </Field>
            )}
          </form.Field>
        </ConfigSection>

        <ConfigSection
          title="Limits"
          description="Checked before each model call. Leave a field empty to keep the platform default shown."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {CONFIG_LIMIT_FIELDS.map(({ key, label, isUsd }) => (
              <form.Field key={key} name={`limits.${key}`}>
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={`config-limit-${key}`}>{label}</FieldLabel>
                    <Input
                      id={`config-limit-${key}`}
                      inputMode={isUsd ? "decimal" : "numeric"}
                      placeholder={String(Schemas.CONFIG_SPEC_PLATFORM_DEFAULTS.limits[key])}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                  </Field>
                )}
              </form.Field>
            ))}
          </div>
        </ConfigSection>
      </fieldset>

      {issues.length > 0 && (
        <Alert className="border-0 bg-destructive-soft">
          <AlertTitle className="text-foreground">The draft wasn't saved</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4 text-subtle-foreground">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {isEditable && (
        <div className="flex justify-end">
          <form.Subscribe selector={(state) => [state.isSubmitting, state.isDirty] as const}>
            {([isSubmitting, isFormDirty]) => (
              <Button type="submit" disabled={isSubmitting || (!isFormDirty && !isNew)}>
                {isSubmitting ? "Saving…" : "Save draft"}
              </Button>
            )}
          </form.Subscribe>
        </div>
      )}
    </form>
  );
}
