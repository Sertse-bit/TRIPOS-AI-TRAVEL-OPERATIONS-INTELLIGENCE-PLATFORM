import Link from "next/link";
import { requireSession } from "@/app/require-auth";
import {
  countUnreadNotifications,
  findNotificationsByUserId,
} from "@/modules/notification/notification-service";
import { Card, EmptyState, SectionHeading } from "@/components/ui";
import { NotificationsList } from "@/app/trips/[id]/trip-actions";

function fmtDateTime(d: Date | string): string {
  return new Date(d).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function NotificationsPage() {
  const user = await requireSession("/trips/notifications");
  const [notifications, unread] = await Promise.all([
    findNotificationsByUserId(user.id),
    countUnreadNotifications(user.id),
  ]);

  return (
    <div>
      <Link href="/trips" className="text-sm text-sand-600 underline-offset-2 hover:underline">
        ← All trips
      </Link>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-navy-950 dark:text-sand-800">
          Notifications
        </h1>
        <p className="text-sm text-sand-600">
          {unread} unread of {notifications.length}
        </p>
      </div>

      <Card className="mt-4">
        <SectionHeading>Your alerts</SectionHeading>
        <p className="mt-1.5 text-sm text-sand-600">
          Raised by the Trip Monitor when a trip&apos;s risk genuinely changes. Repeated checks on
          an unchanged trip stay silent, so this list does not fill up with duplicates.
        </p>
        <div className="mt-3">
          <NotificationsList />
        </div>
      </Card>

      {/* Server-rendered history so the page is useful without interaction. */}
      <Card className="mt-6">
        <SectionHeading>History</SectionHeading>
        {notifications.length === 0 ? (
          <EmptyState>
            <span className="mt-2 block">
              Nothing yet. Open a trip and run a monitor check to start.
            </span>
          </EmptyState>
        ) : (
          <ul className="mt-3 divide-y divide-sand-200 dark:divide-sand-200">
            {notifications.map((notification) => (
              <li key={notification.id} className="py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-sm text-navy-950 dark:text-sand-800">
                    {notification.title}
                    {notification.readAt ? null : (
                      <span className="ml-2 text-xs font-semibold text-warn-700 dark:text-warn-500">
                        unread
                      </span>
                    )}
                  </p>
                  <time className="flex-none text-xs text-sand-600">
                    {fmtDateTime(notification.createdAt)}
                  </time>
                </div>
                <p className="mt-0.5 text-xs text-sand-600">{notification.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
