import {decorate} from './jsrpc-entry-helper.ts';

export const actions = {
  decorated: (_runtime: unknown, input: {value: string}) => decorate(input.value),
};
