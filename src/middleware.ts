import { NextFunction, Request, Response } from "@tinyhttp/app";

export const auth = async (_req: Request, _res: Response, next: NextFunction): Promise<void> => {
  await next();
};
