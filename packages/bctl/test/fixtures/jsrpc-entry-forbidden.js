import pg from 'pg';

export const actions = {
  forbidden: () => Boolean(pg),
};
