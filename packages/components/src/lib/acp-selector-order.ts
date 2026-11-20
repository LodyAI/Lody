import { isAcpPlanModeConfigOption } from '@lody/shared';
import {
  isFastModeSelector,
  isSpeedTierSelector,
  isThoughtLevelSelector,
  type AcpBooleanConfigOptionSelector,
  type AcpConfigOptionSelector,
  type AcpSelectConfigOptionSelector,
} from '../components/shared/acp-selector-options';

export type OrderedAcpConfigOptionSelectors = {
  modelSelectors: AcpSelectConfigOptionSelector[];
  thoughtLevelSelectors: AcpConfigOptionSelector[];
  speedTierSelectors: AcpSelectConfigOptionSelector[];
  fastModeSelectors: AcpConfigOptionSelector[];
  planModeSelectors: AcpConfigOptionSelector[];
  booleanSelectors: AcpBooleanConfigOptionSelector[];
  interactionModeSelectors: AcpSelectConfigOptionSelector[];
  permissionModeSelectors: AcpSelectConfigOptionSelector[];
  modeSelectors: AcpSelectConfigOptionSelector[];
  otherSelectors: AcpConfigOptionSelector[];
};

export const orderAcpConfigOptionSelectors = (
  selectors: AcpConfigOptionSelector[]
): OrderedAcpConfigOptionSelectors => {
  const ordered: OrderedAcpConfigOptionSelectors = {
    modelSelectors: [],
    thoughtLevelSelectors: [],
    speedTierSelectors: [],
    fastModeSelectors: [],
    planModeSelectors: [],
    booleanSelectors: [],
    interactionModeSelectors: [],
    permissionModeSelectors: [],
    modeSelectors: [],
    otherSelectors: [],
  };

  for (const selector of selectors) {
    if (selector.category === 'model' && selector.type === 'select') {
      ordered.modelSelectors.push(selector);
      continue;
    }
    if (isThoughtLevelSelector(selector)) {
      ordered.thoughtLevelSelectors.push(selector);
      continue;
    }
    if (selector.configId === 'interaction_mode' && selector.type === 'select') {
      ordered.interactionModeSelectors.push(selector);
      continue;
    }
    if (
      selector.type === 'select' &&
      (selector.configId === 'permission_mode' || selector.category === '_permission')
    ) {
      ordered.permissionModeSelectors.push(selector);
      continue;
    }
    if (selector.category === 'mode' && selector.type === 'select') {
      ordered.modeSelectors.push(selector);
      continue;
    }
    if (isSpeedTierSelector(selector)) {
      ordered.speedTierSelectors.push(selector);
      continue;
    }
    if (isFastModeSelector(selector)) {
      ordered.fastModeSelectors.push(selector);
      continue;
    }
    if (isAcpPlanModeConfigOption({ id: selector.configId, category: selector.category })) {
      ordered.planModeSelectors.push(selector);
      continue;
    }
    if (selector.type === 'boolean') {
      ordered.booleanSelectors.push(selector);
      continue;
    }
    ordered.otherSelectors.push(selector);
  }

  return ordered;
};
