import { z } from '@hono/zod-openapi';
import { dateTimeSchema, pathSchema, shaSchema } from '../common';

/** 両方のfiles操作で共有する、空でなく重複しないファイルパス一覧。 */
export const filePathsSchema = z
  .array(pathSchema)
  .min(1)
  .refine((paths) => new Set(paths).size === paths.length)
  .openapi({ uniqueItems: true });

export const fileSchema = z
  .strictObject({
    path: pathSchema,
    url: z.url(),
    sha: shaSchema,
    size: z.number().int().min(0),
    updatedAt: dateTimeSchema.nullable(),
  })
  .openapi('File');
