import type { ReactNode } from 'react';
import { PanelLeft } from 'lucide-react';
import { Button } from '@lody/ui/button';
import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  root: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    width: '100%',
    flexDirection: 'column',
    overflow: 'hidden',
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  column: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    width: '100%',
    flexDirection: 'column',
  },
  header: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    paddingBottom: themeSpace[2],
    paddingLeft: 'calc(16px + var(--safe-area-left))',
    paddingRight: 'calc(16px + var(--safe-area-right))',
    paddingTop: 'calc(16px + var(--safe-area-top))',
  },
  menuIcon: {
    width: themeSpace[4],
    height: themeSpace[4],
  },
  scroll: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'auto',
    paddingBottom: 'calc(24px + env(safe-area-inset-bottom, 0px))',
    paddingLeft: 'calc(16px + env(safe-area-inset-left, 0px))',
    paddingRight: 'calc(16px + env(safe-area-inset-right, 0px))',
  },
  content: {
    marginInline: 'auto',
    display: 'flex',
    width: '100%',
    maxWidth: '48rem',
    flexDirection: 'column',
    alignItems: 'center',
    gap: themeSpace[4],
    paddingTop: themeSpace[6],
    paddingBottom: themeSpace[6],
  },
  title: {
    fontSize: themeFontSize['3xl'],
    lineHeight: themeLineHeight['3xl'],
    fontWeight: themeFontWeight.semibold,
    color: themeColors.foreground,
  },
  composerBlock: {
    marginTop: themeSpace[2],
    width: '100%',
  },
  visuallyHidden: {
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    position: 'absolute',
    overflow: 'hidden',
  },
  noMachineHint: {
    marginTop: themeSpace[2],
  },
  agentConfigHint: {
    width: '100%',
  },
});

export type MobileChatLandingScreenProps = {
  title: string;
  contextSwitch?: ReactNode;
  composer: ReactNode;
  noMachineHint?: ReactNode;
  agentConfigHint?: ReactNode;
  onOpenMobileDrawer?: () => void;
};

export function MobileChatLandingScreen({
  title,
  contextSwitch,
  composer,
  noMachineHint,
  agentConfigHint,
  onOpenMobileDrawer,
}: MobileChatLandingScreenProps) {
  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.column)}>
        <div {...stylex.props(styles.header)}>
          <Button
            variant="ghost"
            size="large"
            icon
            className="md:hidden"
            onClick={onOpenMobileDrawer}
          >
            <PanelLeft className={stylex.props(styles.menuIcon).className} />
            <span {...stylex.props(styles.visuallyHidden)}>Open sidebar</span>
          </Button>
          <span {...stylex.props(styles.visuallyHidden)}>{title}</span>
        </div>

        <div {...stylex.props(styles.scroll)}>
          <div {...stylex.props(styles.content)}>
            <h1 {...stylex.props(styles.title)}>{title}</h1>
            {contextSwitch}
            <div {...stylex.props(styles.composerBlock)}>
              {composer}
              {noMachineHint != null ? (
                <div {...stylex.props(styles.noMachineHint)}>{noMachineHint}</div>
              ) : null}
            </div>
            {agentConfigHint != null ? (
              <div {...stylex.props(styles.agentConfigHint)}>{agentConfigHint}</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
