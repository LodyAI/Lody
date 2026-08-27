import { spawnSync } from 'node:child_process';
import { win32 as pathWin32 } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import iconv from 'iconv-lite';
import {
  decodeBuffer,
  isValidUtf8,
  getWindowsOemCodePage,
  setWindowsOemCodePageForTesting,
  setLocaleForTesting,
} from './encoding';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

const mockedSpawnSync = vi.mocked(spawnSync);
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const environmentVariables = [
  'LC_ALL',
  'LC_CTYPE',
  'LANG',
  'LOCALE',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
] as const;
const originalLocaleEnvironment = Object.fromEntries(
  environmentVariables.map((name) => [name, process.env[name]])
) as Record<(typeof environmentVariables)[number], string | undefined>;

function setChcpResult(stdout: Buffer, status = 0): void {
  mockedSpawnSync.mockReturnValue({
    pid: 1,
    output: [null, stdout, Buffer.alloc(0)],
    stdout,
    stderr: Buffer.alloc(0),
    status,
    signal: null,
  } as never);
}

function setCorroboratedWindowsPaths(root = 'C:\\Windows'): void {
  process.env.SystemRoot = root;
  process.env.WINDIR = root;
  process.env.ComSpec = pathWin32.join(root, 'System32', 'cmd.exe');
}

describe('encoding utilities', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    mockedSpawnSync.mockReset();
    setChcpResult(Buffer.alloc(0), 1);
    setCorroboratedWindowsPaths();

    // Reset cached values before each test
    setWindowsOemCodePageForTesting(null);
    setLocaleForTesting(null);
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    for (const name of environmentVariables) {
      const value = originalLocaleEnvironment[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    vi.restoreAllMocks();

    // Clean up after each test
    setWindowsOemCodePageForTesting(null);
    setLocaleForTesting(null);
  });

  describe('isValidUtf8', () => {
    it('should return true for empty buffer', () => {
      expect(isValidUtf8(Buffer.alloc(0))).toBe(true);
    });

    it('should return true for ASCII-only content', () => {
      const buffer = Buffer.from('Hello, World!', 'utf8');
      expect(isValidUtf8(buffer)).toBe(true);
    });

    it('should return true for valid UTF-8 with Chinese characters', () => {
      const buffer = Buffer.from('你好世界', 'utf8');
      expect(isValidUtf8(buffer)).toBe(true);
    });

    it('should return true for valid UTF-8 with emoji', () => {
      const buffer = Buffer.from('Hello 👋 World 🌍', 'utf8');
      expect(isValidUtf8(buffer)).toBe(true);
    });

    it('should return true for valid UTF-8 with mixed content', () => {
      const buffer = Buffer.from('Hello 你好 мир 🌍', 'utf8');
      expect(isValidUtf8(buffer)).toBe(true);
    });

    it('should return true for UTF-8 BOM', () => {
      const buffer = Buffer.from([0xef, 0xbb, 0xbf, 0x48, 0x65, 0x6c, 0x6c, 0x6f]); // BOM + "Hello"
      expect(isValidUtf8(buffer)).toBe(true);
    });

    it('should return false for invalid UTF-8 (GBK encoded Chinese)', () => {
      // "你好" in GBK encoding
      const gbkBuffer = iconv.encode('你好', 'gbk');
      expect(isValidUtf8(gbkBuffer)).toBe(false);
    });

    it('should return false for invalid continuation byte', () => {
      // Invalid: continuation byte without a start byte
      const buffer = Buffer.from([0x80, 0x81]);
      expect(isValidUtf8(buffer)).toBe(false);
    });

    it('should return false for truncated multi-byte sequence', () => {
      // Start of 3-byte sequence without continuation
      const buffer = Buffer.from([0xe4, 0xbd]);
      expect(isValidUtf8(buffer)).toBe(false);
    });

    it('should return false for overlong encoding', () => {
      // Overlong encoding of ASCII 'A' (should be 0x41, not 0xC0 0x81)
      const buffer = Buffer.from([0xc0, 0x81]);
      expect(isValidUtf8(buffer)).toBe(false);
    });
  });

  describe('decodeBuffer', () => {
    it('should decode UTF-8 buffer correctly', () => {
      const buffer = Buffer.from('Hello, 你好!', 'utf8');
      expect(decodeBuffer(buffer)).toBe('Hello, 你好!');
    });

    it('should return empty string for empty buffer', () => {
      expect(decodeBuffer(Buffer.alloc(0))).toBe('');
    });

    it('should decode ASCII correctly', () => {
      const buffer = Buffer.from('Hello, World!', 'utf8');
      expect(decodeBuffer(buffer)).toBe('Hello, World!');
    });

    it('should respect forceEncoding parameter', () => {
      // "你好" in GBK
      const gbkBuffer = iconv.encode('你好', 'gbk');
      expect(decodeBuffer(gbkBuffer, 'gbk')).toBe('你好');
    });

    it('should decode GBK output through the detected Windows code page', () => {
      setChcpResult(Buffer.from('Active code page: 936\r\n'));
      const gbkBuffer = iconv.encode('测试中文输出', 'gbk');

      expect(decodeBuffer(gbkBuffer)).toBe('测试中文输出');
      expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    });

    it('should decode CP936 (GBK) correctly with forceEncoding', () => {
      const text = '这是一个测试';
      const cp936Buffer = iconv.encode(text, 'cp936');
      expect(decodeBuffer(cp936Buffer, 'cp936')).toBe(text);
    });

    it('should decode CP932 (Shift-JIS) correctly with forceEncoding', () => {
      const text = 'こんにちは';
      const cp932Buffer = iconv.encode(text, 'cp932');
      expect(decodeBuffer(cp932Buffer, 'cp932')).toBe(text);
    });

    it('should decode CP949 (Korean) correctly with forceEncoding', () => {
      const text = '안녕하세요';
      const cp949Buffer = iconv.encode(text, 'cp949');
      expect(decodeBuffer(cp949Buffer, 'cp949')).toBe(text);
    });

    it('should keep invalid UTF-8 on the UTF-8 path outside Windows', () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
      const buffer = iconv.encode('你好', 'cp936');

      expect(decodeBuffer(buffer)).toBe(buffer.toString('utf8'));
      expect(mockedSpawnSync).not.toHaveBeenCalled();
    });
  });

  describe('getWindowsOemCodePage', () => {
    it('should detect the active code page from localized chcp output', () => {
      setLocaleForTesting('ja-JP');
      setChcpResult(
        Buffer.concat([
          Buffer.from([0x8b, 0x43, 0x83, 0x52, 0x81, 0x5b, 0x83, 0x68]),
          Buffer.from(': 936\r\n'),
        ])
      );

      expect(getWindowsOemCodePage()).toBe('cp936');
      expect(mockedSpawnSync).toHaveBeenCalledWith(
        pathWin32.join(process.env.SystemRoot, 'System32', 'cmd.exe'),
        ['/d', '/s', '/c', 'chcp'],
        expect.objectContaining({
          encoding: null,
          windowsHide: true,
          timeout: 2_000,
          maxBuffer: 64 * 1024,
        })
      );
    });

    it('should map code page 65001 to utf8', () => {
      setChcpResult(Buffer.from('Active code page: 65001\r\n'));

      expect(getWindowsOemCodePage()).toBe('utf8');
    });

    it('should map Windows code page 54936 to gb18030 and decode its output', () => {
      setChcpResult(Buffer.from('Active code page: 54936\r\n'));
      const text = '𠀀';
      const buffer = iconv.encode(text, 'gb18030');

      expect(isValidUtf8(buffer)).toBe(false);
      expect(getWindowsOemCodePage()).toBe('gb18030');
      expect(decodeBuffer(buffer)).toBe(text);
    });

    it('should use WINDIR when SystemRoot is unavailable', () => {
      delete process.env.SystemRoot;
      process.env.WINDIR = 'D:\\Windows';
      process.env.ComSpec = 'D:\\Windows\\System32\\cmd.exe';
      setChcpResult(Buffer.from('Active code page: 932\r\n'));

      expect(getWindowsOemCodePage()).toBe('cp932');
      expect(mockedSpawnSync).toHaveBeenCalledWith(
        pathWin32.join(process.env.WINDIR, 'System32', 'cmd.exe'),
        ['/d', '/s', '/c', 'chcp'],
        expect.any(Object)
      );
    });

    it('should skip the probe when no trusted Windows directory is available', () => {
      delete process.env.SystemRoot;
      delete process.env.WINDIR;
      process.env.ComSpec = 'C:\\untrusted\\cmd.exe';
      setLocaleForTesting('ja-JP');
      setChcpResult(Buffer.from('Active code page: 936\r\n'));

      expect(getWindowsOemCodePage()).toBe('cp932');
      expect(mockedSpawnSync).not.toHaveBeenCalled();
    });

    it.each([
      '.',
      'C:relative',
      'C:\\.',
      'C:\\..',
      'C:\\Windows\\..\\workspace',
      '\\\\server\\share\\Windows',
    ])('should reject an untrusted Windows directory: %s', (root) => {
      process.env.SystemRoot = root;
      process.env.WINDIR = root;
      process.env.ComSpec = pathWin32.join(root, 'System32', 'cmd.exe');
      setLocaleForTesting('ja-JP');
      setChcpResult(Buffer.from('Active code page: 936\r\n'));

      expect(getWindowsOemCodePage()).toBe('cp932');
      expect(mockedSpawnSync).not.toHaveBeenCalled();
    });

    it('should reject a command processor that disagrees with the Windows directory', () => {
      process.env.ComSpec = 'D:\\workspace\\cmd.exe';
      setLocaleForTesting('ja-JP');
      setChcpResult(Buffer.from('Active code page: 936\r\n'));

      expect(getWindowsOemCodePage()).toBe('cp932');
      expect(mockedSpawnSync).not.toHaveBeenCalled();
    });

    it('should ignore unsupported chcp values and fall back to the locale', () => {
      setChcpResult(Buffer.from('Active code page: 99999\r\n'));
      setLocaleForTesting('zh-SG');

      expect(getWindowsOemCodePage()).toBe('cp936');
    });

    it('should ignore malformed chcp output and fall back to the locale', () => {
      setChcpResult(Buffer.from('chcp failed with diagnostic 1252\r\n'));
      setLocaleForTesting('zh-SG');

      expect(getWindowsOemCodePage()).toBe('cp936');
    });

    it.each([
      {
        name: 'LC_CTYPE over LANG',
        environment: { LC_ALL: '', LC_CTYPE: 'ja_JP.UTF-8', LANG: 'zh_CN.UTF-8' },
        expected: 'cp932',
      },
      {
        name: 'LANG over LOCALE',
        environment: { LC_ALL: '', LC_CTYPE: '', LANG: 'zh_CN.UTF-8', LOCALE: 'ru_RU.UTF-8' },
        expected: 'cp936',
      },
      {
        name: 'LOCALE over Intl',
        environment: { LC_ALL: '', LC_CTYPE: '', LANG: '', LOCALE: 'ru_RU.UTF-8' },
        expected: 'cp866',
      },
    ])('should prefer $name', ({ environment, expected }) => {
      Object.assign(process.env, environment);
      vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
        locale: 'zh-SG',
        calendar: 'gregory',
        numberingSystem: 'latn',
        timeZone: 'Asia/Singapore',
      });

      expect(getWindowsOemCodePage()).toBe(expected);
    });

    it('should prefer LC_ALL over other locale environment variables', () => {
      process.env.LC_ALL = 'zh_CN.UTF-8';
      process.env.LC_CTYPE = 'ja_JP.UTF-8';
      process.env.LANG = 'en_US.UTF-8';
      process.env.LOCALE = 'ru_RU.UTF-8';

      expect(getWindowsOemCodePage()).toBe('cp936');
    });

    it('should fall back to the Intl locale when environment locales are unusable', () => {
      process.env.LC_ALL = '';
      process.env.LC_CTYPE = '';
      process.env.LANG = 'C.UTF-8';
      process.env.LOCALE = '';
      vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
        locale: 'zh-SG',
        calendar: 'gregory',
        numberingSystem: 'latn',
        timeZone: 'Asia/Singapore',
      });

      expect(getWindowsOemCodePage()).toBe('cp936');
    });

    it('should map traditional Chinese BCP 47 locales to cp950', () => {
      process.env.LC_ALL = 'zh-Hant-HK.UTF-8';

      expect(getWindowsOemCodePage()).toBe('cp950');
    });

    it.each([
      ['ja', 'cp932'],
      ['ja-Jpan-JP', 'cp932'],
      ['ko', 'cp949'],
      ['ru', 'cp866'],
    ])('should resolve language-level locale %s to %s', (locale, expected) => {
      setLocaleForTesting(locale);

      expect(getWindowsOemCodePage()).toBe(expected);
    });

    it('should probe the active code page only once', () => {
      setChcpResult(Buffer.from('Active code page: 936\r\n'));

      expect(getWindowsOemCodePage()).toBe('cp936');
      setChcpResult(Buffer.from('Active code page: 932\r\n'));
      expect(getWindowsOemCodePage()).toBe('cp936');
      expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    });

    it('should retry a failed probe after a bounded delay', () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      setLocaleForTesting('ja-JP');

      expect(getWindowsOemCodePage()).toBe('cp932');
      expect(mockedSpawnSync).toHaveBeenCalledTimes(1);

      setChcpResult(Buffer.from('Active code page: 936\r\n'));
      now.mockReturnValue(30_999);
      expect(getWindowsOemCodePage()).toBe('cp932');
      expect(mockedSpawnSync).toHaveBeenCalledTimes(1);

      now.mockReturnValue(31_000);
      expect(getWindowsOemCodePage()).toBe('cp936');
      expect(mockedSpawnSync).toHaveBeenCalledTimes(2);
    });

    it('should refresh a successful probe after its cache expires', () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      setChcpResult(Buffer.from('Active code page: 936\r\n'));

      expect(getWindowsOemCodePage()).toBe('cp936');
      setChcpResult(Buffer.from('Active code page: 932\r\n'));

      now.mockReturnValue(300_999);
      expect(getWindowsOemCodePage()).toBe('cp936');
      expect(mockedSpawnSync).toHaveBeenCalledTimes(1);

      now.mockReturnValue(301_000);
      expect(getWindowsOemCodePage()).toBe('cp932');
      expect(mockedSpawnSync).toHaveBeenCalledTimes(2);
    });

    it('should retain the last successful code page when a refresh fails', () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      setLocaleForTesting('ja-JP');
      setChcpResult(Buffer.from('Active code page: 936\r\n'));

      expect(getWindowsOemCodePage()).toBe('cp936');

      setChcpResult(Buffer.alloc(0), 1);
      now.mockReturnValue(301_000);
      expect(getWindowsOemCodePage()).toBe('cp936');

      now.mockReturnValue(330_999);
      expect(getWindowsOemCodePage()).toBe('cp936');
      expect(mockedSpawnSync).toHaveBeenCalledTimes(2);

      setChcpResult(Buffer.from('Active code page: 932\r\n'));
      now.mockReturnValue(331_000);
      expect(getWindowsOemCodePage()).toBe('cp932');
      expect(mockedSpawnSync).toHaveBeenCalledTimes(3);
    });

    it('should return cp936 for zh-CN locale', () => {
      setLocaleForTesting('zh-CN');
      setWindowsOemCodePageForTesting(null); // Reset to force re-detection
      expect(getWindowsOemCodePage()).toBe('cp936');
    });

    it('should return cp950 for zh-TW locale', () => {
      setLocaleForTesting('zh-TW');
      setWindowsOemCodePageForTesting(null);
      expect(getWindowsOemCodePage()).toBe('cp950');
    });

    it('should return cp932 for ja-JP locale', () => {
      setLocaleForTesting('ja-JP');
      setWindowsOemCodePageForTesting(null);
      expect(getWindowsOemCodePage()).toBe('cp932');
    });

    it('should return cp949 for ko-KR locale', () => {
      setLocaleForTesting('ko-KR');
      setWindowsOemCodePageForTesting(null);
      expect(getWindowsOemCodePage()).toBe('cp949');
    });

    it('should return cp866 for ru-RU locale', () => {
      setLocaleForTesting('ru-RU');
      setWindowsOemCodePageForTesting(null);
      expect(getWindowsOemCodePage()).toBe('cp866');
    });

    it('should cache the code page', () => {
      setWindowsOemCodePageForTesting('cp936');
      expect(getWindowsOemCodePage()).toBe('cp936');

      // Even if we change locale, cached value should persist
      setLocaleForTesting('ja-JP');
      expect(getWindowsOemCodePage()).toBe('cp936');
    });
  });
});
