import { withApiHandler } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";

export const GET = withApiHandler(async () => {
  const user = await requireAuth();
  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  };
});
