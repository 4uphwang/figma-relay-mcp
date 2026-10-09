import type { Handlers } from '../bridgeTypes';
import { execute } from './execute';
import { exportPdf } from './exportPdf';
import { findNodes, getNode, getSelection, getStatus, screenshot } from './read';

export const handlers: Partial<Handlers> = {
  getStatus,
  getSelection,
  getNode,
  findNodes,
  screenshot,
  execute,
  exportPdf,
};
