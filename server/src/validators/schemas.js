'use strict';

// Request/response validation schemas (control #6). Every schema that maps to
// a request body is strict: unknown fields are rejected rather than silently
// stripped, so typos and smuggled parameters fail loudly.
const {
  z,
  emailSchema,
  passwordSchema,
  nameSchema,
  objectIdSchema,
  totpCodeSchema,
  pageSchema,
  limitSchema,
} = require('../middleware/validate');

const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, 'Password is required').max(200),
  })
  .strict();

const mfaVerifySchema = z
  .object({
    code: totpCodeSchema.optional(),
    recoveryCode: z.string().trim().regex(/^[a-f0-9]{10}$/, 'Invalid recovery code').optional(),
  })
  .strict()
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: 'Provide either a 6-digit code or a recovery code.',
  });

const mfaEnrollVerifySchema = z.object({ code: totpCodeSchema }).strict();

const acceptInvitationSchema = z
  .object({
    token: z.string().trim().min(16).max(200),
    name: nameSchema.optional(),
    password: passwordSchema,
  })
  .strict();

const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

const resetPasswordSchema = z
  .object({
    token: z.string().trim().min(16).max(200),
    password: passwordSchema,
  })
  .strict();

const createClinicSchema = z.object({ name: nameSchema }).strict();

const paginationQuery = z
  .object({
    page: pageSchema,
    limit: limitSchema,
    query: z.string().trim().max(120).optional(),
  })
  .passthrough();

const inviteStaffSchema = z
  .object({
    email: emailSchema,
    roleKey: z.enum(['admin', 'care_coordinator', 'clinical_reviewer']),
  })
  .strict();

const updateMemberSchema = z
  .object({
    roleKey: z.enum(['admin', 'care_coordinator', 'clinical_reviewer']).optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.roleKey) || Boolean(v.status), {
    message: 'Provide at least one field to update.',
  });

const memberIdParam = z.object({ membershipId: objectIdSchema }).strict();
const invitationIdParam = z.object({ invitationId: objectIdSchema }).strict();

const reviewerEligibilitySchema = z
  .object({ action: z.enum(['verify', 'revoke']) })
  .strict();

const updateClinicSchema = z
  .object({ name: nameSchema })
  .strict();

module.exports = {
  loginSchema,
  mfaVerifySchema,
  mfaEnrollVerifySchema,
  acceptInvitationSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  createClinicSchema,
  paginationQuery,
  inviteStaffSchema,
  updateMemberSchema,
  memberIdParam,
  invitationIdParam,
  reviewerEligibilitySchema,
  updateClinicSchema,
};
