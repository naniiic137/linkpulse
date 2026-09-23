import { Type, type Static } from '@sinclair/typebox';

/** JSON schemas shared by validation, response serialisation and the OpenAPI document. */

export const ErrorSchema = Type.Object(
  {
    error: Type.Object({
      code: Type.String(),
      message: Type.String(),
      details: Type.Optional(Type.Unknown()),
    }),
  },
  { $id: 'Error', description: 'Every non-2xx JSON response has this shape.' },
);

const Nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([t, Type.Null()]);

export const UserSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    email: Type.String(),
    name: Type.String(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'User' },
);

export const LinkSchema = Type.Object(
  {
    id: Type.String({ description: 'Numeric id (string-encoded)' }),
    code: Type.String({ description: 'Short code or custom alias' }),
    shortUrl: Type.String({ format: 'uri' }),
    url: Type.String({ format: 'uri', description: 'Destination' }),
    title: Nullable(Type.String()),
    faviconUrl: Nullable(Type.String()),
    isCustom: Type.Boolean(),
    hasPassword: Type.Boolean(),
    expiresAt: Nullable(Type.String({ format: 'date-time' })),
    maxClicks: Type.Union([Type.Integer(), Type.Null()]),
    disabled: Type.Boolean(),
    publicStats: Type.Boolean(),
    clickCount: Type.Integer({ description: 'Human clicks persisted so far (eventually consistent, ~1 s)' }),
    status: Type.Union([
      Type.Literal('active'),
      Type.Literal('expired'),
      Type.Literal('disabled'),
      Type.Literal('limit_reached'),
    ]),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'Link' },
);

export const CreateLinkBody = Type.Object(
  {
    url: Type.String({ maxLength: 2048, description: 'http(s) destination', examples: ['https://example.com/launch'] }),
    alias: Type.Optional(Type.String({ maxLength: 32, description: '3-32 chars [A-Za-z0-9_-]; reserved words refused' })),
    expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
    maxClicks: Type.Optional(Type.Integer({ minimum: 1 })),
    password: Type.Optional(Type.String({ minLength: 4, maxLength: 128 })),
    publicStats: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type CreateLinkBody = Static<typeof CreateLinkBody>;

export const UpdateLinkBody = Type.Object(
  {
    url: Type.Optional(Type.String({ maxLength: 2048 })),
    disabled: Type.Optional(Type.Boolean()),
    expiresAt: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
    maxClicks: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
    password: Type.Optional(Type.Union([Type.String({ minLength: 4, maxLength: 128 }), Type.Null()])),
    publicStats: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateLinkBody = Static<typeof UpdateLinkBody>;

const NamedCount = Type.Object({ name: Type.String(), clicks: Type.Integer() });
const Point = Type.Object({ t: Type.String({ format: 'date-time' }), clicks: Type.Integer() });

export const AnalyticsSchema = Type.Object(
  {
    linkId: Type.String(),
    range: Type.Object({
      from: Type.String({ format: 'date-time' }),
      to: Type.String({ format: 'date-time' }),
      bucket: Type.Union([Type.Literal('hour'), Type.Literal('day')]),
    }),
    totals: Type.Object({
      clicks: Type.Integer(),
      uniqueVisitors: Type.Integer({ description: 'HyperLogLog estimate (±0.81%), day granularity' }),
      bots: Type.Integer(),
    }),
    timeseries: Type.Array(Point),
    referrers: Type.Array(NamedCount),
    countries: Type.Array(NamedCount),
    browsers: Type.Array(NamedCount),
    os: Type.Array(NamedCount),
    devices: Type.Array(NamedCount),
  },
  { $id: 'Analytics' },
);

export const RangeQuery = Type.Object({
  from: Type.Optional(Type.String({ format: 'date-time' })),
  to: Type.Optional(Type.String({ format: 'date-time' })),
  bucket: Type.Optional(Type.Union([Type.Literal('hour'), Type.Literal('day')])),
});

export const ApiKeySchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    prefix: Type.String(),
    createdAt: Type.String({ format: 'date-time' }),
    lastUsedAt: Nullable(Type.String({ format: 'date-time' })),
  },
  { $id: 'ApiKey' },
);

export const IdParams = Type.Object({ id: Type.String({ pattern: '^[0-9]{1,18}$' }) });

export const errorResponses = {
  400: Type.Ref(ErrorSchema),
  401: Type.Ref(ErrorSchema),
  404: Type.Ref(ErrorSchema),
  429: Type.Ref(ErrorSchema),
};
