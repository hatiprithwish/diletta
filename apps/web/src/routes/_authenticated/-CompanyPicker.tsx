import { Badge } from "@app/ui/components/badge";
import { Button } from "@app/ui/components/button";
import * as Schemas from "@app/schemas";
import { ShellMessage } from "./-ShellMessage";

// DEV_NOTE: ADR 0006. A signed-in operator picks the company to act in as an admin; the shell keeps the pick in the
// URL (?company=) and records the entry in that company's audit log
export function CompanyPicker({ companies, onPick }: Schemas.DashboardCompanyPickerProps) {
  if (companies.length === 0) {
    return (
      <ShellMessage
        title="No companies yet"
        description="Create a company first, then open its dashboard here."
      />
    );
  }

  return (
    <ShellMessage
      title="Open a company's dashboard"
      description="You'll act as one of its admins. Everything you change is recorded as Diletta support."
    >
      <ul className="flex w-full max-w-sm flex-col gap-2" aria-label="Companies">
        {companies.map((company) => (
          <li key={company.publicId}>
            <Button
              variant="outline"
              className="w-full justify-between"
              onClick={() => onPick(company.publicId)}
            >
              <span className="truncate">{company.name}</span>
              {company.status !== Schemas.CompanyStatusIntEnum.Active && (
                <Badge variant="secondary">{company.statusLabel}</Badge>
              )}
            </Button>
          </li>
        ))}
      </ul>
    </ShellMessage>
  );
}
