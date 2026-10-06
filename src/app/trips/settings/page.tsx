import { requireSession } from "@/app/require-auth";
import { providerAvailability } from "@/config/env";
import { Card, SectionHeading } from "@/components/ui";

export default async function SettingsPage() {
  const user = await requireSession("/trips/settings");
  // providerAvailability is a plain object on the server env module. Only
  // the boolean "configured" flags are rendered — never values or keys.

  return <SettingsView userName={user.name} userEmail={user.email} userRole={user.role} />;
}

function SettingsView({
  userName,
  userEmail,
  userRole,
}: {
  userName: string;
  userEmail: string;
  userRole: string;
}) {
  const providers = Object.entries(providerAvailability);
  const configured = providers.filter(([, available]) => available).length;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-navy-950 dark:text-sand-800">
        Settings
      </h1>
      <p className="mt-1 text-sm text-sand-600">
        Account and integration status. Provider keys are configured server-side only — names and
        availability only, never values.
      </p>

      <div className="mt-6 grid gap-4">
        <Card>
          <SectionHeading>Account</SectionHeading>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-sand-600">Name</dt>
              <dd className="font-medium text-navy-950 dark:text-sand-800">{userName}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-sand-600">Email</dt>
              <dd className="font-medium text-navy-950 dark:text-sand-800">{userEmail}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-sand-600">Role</dt>
              <dd className="font-medium text-navy-950 dark:text-sand-800">{userRole}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <SectionHeading>
            Integrations ({configured}/{providers.length} configured)
          </SectionHeading>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {providers.map(([name, available]) => (
              <li
                key={name}
                className="flex items-center justify-between rounded-lg border border-sand-200 px-3 py-2 dark:border-sand-200"
              >
                <span className="font-mono text-sm text-navy-950 dark:text-sand-800">{name}</span>
                <span
                  className={`text-xs font-semibold ${available ? "text-ok-600" : "text-sand-600"}`}
                >
                  {available ? "Configured" : "Not configured"}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-sand-600">
            Availability reflects real env-var presence, read from the server at request time. Most
            unconfigured providers fall back to a documented mock adapter that says so in its own
            output. Anthropic is the exception: it has no mock, because a fabricated explanation of
            a risk score is exactly the kind of invented capability this project refuses. Without
            it, risk scoring still works in full and only the natural-language explanations are
            unavailable.
          </p>
        </Card>
      </div>
    </div>
  );
}
