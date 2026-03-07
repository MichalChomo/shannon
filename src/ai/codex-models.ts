// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

import type { ModelTier } from './models.js';

const DEFAULT_CODEX_MODELS: Readonly<Record<ModelTier, string>> = {
  small: 'gpt-5.1-codex-mini',
  medium: 'gpt-5.3-codex',
  large: 'gpt-5.4',
};

export function resolveCodexModel(tier: ModelTier = 'medium'): string {
  switch (tier) {
    case 'small':
      return process.env.CODEX_SMALL_MODEL || DEFAULT_CODEX_MODELS.small;
    case 'large':
      return process.env.CODEX_LARGE_MODEL || DEFAULT_CODEX_MODELS.large;
    default:
      return process.env.CODEX_MEDIUM_MODEL || DEFAULT_CODEX_MODELS.medium;
  }
}
