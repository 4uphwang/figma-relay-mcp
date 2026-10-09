import type { Handlers } from '../bridgeTypes';
import { execute } from './execute';
import { exportPdf } from './exportPdf';
import { fillTemplate } from './template';
import { findNodes, getNode, getSelection, getStatus, screenshot } from './read';

export const handlers: Handlers = {
  getStatus,
  getSelection,
  getNode,
  findNodes,
  screenshot,
  execute,
  exportPdf,
  fillTemplate,
};
