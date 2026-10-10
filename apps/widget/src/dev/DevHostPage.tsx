import { Moon, Sun } from "@phosphor-icons/react";
import { Button } from "@app/ui/components/button";
import * as Schemas from "@app/schemas";
import DilettaWidget from "@/DilettaWidget";
import { useDevTheme } from "@/dev/useDevTheme";

// DEV_NOTE: Development only: a stand-in host page (layout after host-Main) with the live widget, talking to the
// local backend (WIDGET_DEV_API_BASE) with tokens from the dev server's /dev/token (scripts/devJwt.ts)
const ROWS = [
  ["EXT-B-014", "Building B, level 2 east stair", "22 Sep 2026", "Open"],
  ["EXT-B-017", "Building B, plant room", "22 Sep 2026", "Open"],
  ["EXT-A-003", "Building A, reception", "15 Oct 2026", "Scheduled"],
  ["EXT-C-002", "Building C, workshop", "30 Aug 2026", "Closed"],
];

async function getDevToken(): Promise<string> {
  const response = await fetch("/dev/token", { cache: "no-store" });
  if (!response.ok) throw new Error(await response.text());
  return await response.text();
}

export default function DevHostPage() {
  const { theme, toggle } = useDevTheme();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex h-14 items-center justify-between border-b border-border px-6">
        <span className="text-section font-semibold">Sample host app</span>
        <Button variant="outline" size="sm" onClick={toggle}>
          {theme === Schemas.WidgetThemeEnum.Dark ? <Sun /> : <Moon />}
          {theme === Schemas.WidgetThemeEnum.Dark ? "Light" : "Dark"}
        </Button>
      </header>
      <main className="p-10">
        <h1 className="text-page-title">Fire safety register</h1>
        <table className="mt-6 w-full max-w-4xl text-body">
          <tbody>
            {ROWS.map(([record, location, due, status]) => (
              <tr key={record} className="border-b border-border">
                <td className="py-3 font-mono text-mono-value">{record}</td>
                <td className="py-3">{location}</td>
                <td className="py-3 text-subtle-foreground">{due}</td>
                <td className="py-3 text-subtle-foreground">{status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </main>
      <DilettaWidget apiBase={Schemas.WIDGET_DEV_API_BASE} theme={theme} getToken={getDevToken} />
    </div>
  );
}
