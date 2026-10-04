import geistLicense from './Geist-LICENSE.txt?raw';
import vivoLicense from './vivo-LICENSE.txt?raw';
import type { OpenSourceAttributionEntry } from '@/lib/open-source-attributions';

export const interfaceFontNotices: OpenSourceAttributionEntry[] = [
  {
    id: 'interface-font-geist',
    kind: 'vendored',
    scope: 'vendored-source',
    name: 'Geist',
    license: 'SIL Open Font License 1.1',
    homepage: 'https://github.com/vercel/geist-font',
    author: 'Copyright (c) 2023 Vercel, in collaboration with basement.studio',
    versions: ['1.7.2'],
    assets: ['Geist variable normal / italic'],
    licenseText: geistLicense,
  },
  {
    id: 'interface-font-vivo',
    kind: 'vendored',
    scope: 'vendored-source',
    name: 'vivo Sans SC',
    license: 'vivo Sans字体知识产权许可协议',
    homepage: 'https://developers.vivo.com/doc/d/314fa33cbaec4a93be351cd44757d9d9',
    author: 'Copyright(c) vivo Mobile Communication Co., Ltd. 维沃移动通信有限公司',
    versions: ['1.05'],
    assets: ['vivo Sans SC variable transport subsets'],
    licenseText: vivoLicense,
  },
];
