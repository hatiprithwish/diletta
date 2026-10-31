import { ArrowCounterClockwise, Trash } from "@phosphor-icons/react";
import { Button } from "@app/ui/components/button";
import { Input } from "@app/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@app/ui/components/native-select";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The editor (DESIGN.md §7 widget-Editing): one input per editable field, its kind from the tool's
// input_schema (a list → select, a yes/no → select, a number, a date, else text), the changed fields that can't be
// edited as plain text, a trash button per record (removed = rejected when the card is approved; it can be put back),
// then Save edits / Cancel. The server checks every edit again before the card asks for approval once more.
function FieldInput({
  field,
  editable,
  value,
  disabled,
  onChange,
}: {
  field: string;
  editable: Schemas.ChangeRequestEditableField;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const options =
    editable.enumValues?.map(String) ??
    (editable.type === Schemas.ChangeRequestFieldTypeEnum.Boolean ? ["true", "false"] : null);
  if (options) {
    return (
      <NativeSelect
        aria-label={field}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full"
      >
        {!options.includes(value) && (
          <NativeSelectOption value={value}>{value || "—"}</NativeSelectOption>
        )}
        {options.map((option) => (
          <NativeSelectOption key={option} value={option}>
            {option}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    );
  }
  const isNumber =
    editable.type === Schemas.ChangeRequestFieldTypeEnum.Number ||
    editable.type === Schemas.ChangeRequestFieldTypeEnum.Integer;
  return (
    <Input
      aria-label={field}
      type={editable.format === "date" ? "date" : "text"}
      inputMode={isNumber ? "decimal" : undefined}
      value={value}
      required={editable.isRequired}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className="text-body"
    />
  );
}

export default function ChangeRequestEditor({ card, actions }: Schemas.WidgetChangeCardProps) {
  const { isSending } = card;
  return (
    <>
      <ul className="flex flex-col">
        {card.records.map((record) => (
          <li
            key={record.changeRequestPublicId}
            className="flex flex-col gap-2.5 border-t border-muted px-3.5 py-3"
          >
            <span className="flex items-center gap-2">
              <span className="min-w-0 grow truncate font-mono text-mono-value text-foreground">
                {record.label ?? "New record"}
              </span>
              {record.isProposed && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={isSending}
                  onClick={() => actions.onToggleRecord(card.id, record.changeRequestPublicId)}
                  aria-label={record.isIncluded ? "Remove this record" : "Put this record back"}
                >
                  {record.isIncluded ? <Trash /> : <ArrowCounterClockwise />}
                </Button>
              )}
            </span>
            {!record.isIncluded ? (
              <p className="text-widget-row text-muted-foreground">
                Removed. This record stays as it is.
              </p>
            ) : (
              record.editFields.map((field) => (
                <div
                  key={field.field}
                  className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-2 text-widget-row"
                >
                  <span className="truncate font-mono text-subtle-foreground">{field.field}</span>
                  {field.editable && record.isProposed ? (
                    <FieldInput
                      field={field.field}
                      editable={field.editable}
                      value={field.value}
                      disabled={isSending}
                      onChange={(value) =>
                        actions.onEditValue(
                          card.id,
                          record.changeRequestPublicId,
                          field.field,
                          value,
                        )
                      }
                    />
                  ) : (
                    <span className="text-foreground">{field.value || "empty"}</span>
                  )}
                </div>
              ))
            )}
          </li>
        ))}
      </ul>
      <footer className="flex flex-wrap gap-2 border-t border-muted px-3.5 py-3">
        <Button
          onClick={() => actions.onSaveEdits(card.id)}
          disabled={isSending}
          className="text-body"
        >
          Save edits
        </Button>
        <Button
          variant="outline"
          onClick={() => actions.onCancelEdit(card.id)}
          disabled={isSending}
          className="text-body"
        >
          Cancel
        </Button>
      </footer>
    </>
  );
}
