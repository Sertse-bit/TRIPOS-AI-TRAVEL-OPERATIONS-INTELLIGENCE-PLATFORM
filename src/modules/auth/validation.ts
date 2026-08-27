import { z } from "zod";
import { validatePasswordStrength } from "@/modules/auth/password";

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z.string().superRefine((password, ctx) => {
    const result = validatePasswordStrength(password);
    if (!result.valid) {
      ctx.addIssue({ code: "custom", message: result.reason });
    }
  }),
  name: z.string().trim().min(1, "Name is required.").max(200),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  // Deliberately not re-validating strength here: a login attempt with a
  // too-short password should fail as "invalid credentials", the same as
  // any other wrong password — not leak that the password is well-formed
  // but wrong via a different error path.
  password: z.string().min(1, "Password is required."),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
