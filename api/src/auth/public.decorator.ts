import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';
/** Opts a route out of the global sign-in requirement (login, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
