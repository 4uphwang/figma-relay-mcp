import type { Handlers } from '../bridgeTypes';
import { execute } from './execute';
import { findNodes, getNode, getSelection, getStatus, screenshot } from './read';

export const handlers: Partial<Handlers> = {
  getStatus,
  getSelection,
  getNode,
  findNodes,
  screenshot,
  execute,
};
