import * as stylex from '@stylexjs/stylex';
import { ScrollArea } from '../scroll-area/scroll-area';
import { scrollbar } from '../scroll-area/scroll-area.tokens.stylex';
import { colors } from '../tokens/colors.stylex';
import { space } from '../tokens/scales.stylex';
import { Rows, Row, Swatch, useMeasured } from './parts';

const styles = stylex.create({
  frame: { height: '160px', width: '100%', backgroundColor: colors.secondaryBackground },
  row: { padding: space[3], whiteSpace: 'nowrap' },
  wide: { width: '720px' },
  compactFrame: { height: '48px' },
  size: { width: scrollbar.size, height: '24px', backgroundColor: scrollbar.thumb },
  inset: { padding: scrollbar.inset },
  compact: { height: scrollbar.compactSize, width: '80px', backgroundColor: scrollbar.thumb },
  radius: {
    width: '40px',
    height: '12px',
    borderRadius: scrollbar.radius,
    backgroundColor: scrollbar.thumb,
  },
});

function Dimensions() {
  const size = useMeasured<HTMLDivElement>('width');
  const inset = useMeasured<HTMLDivElement>('padding-top');
  const compact = useMeasured<HTMLDivElement>('height');
  const radius = useMeasured<HTMLDivElement>('border-radius');
  return (
    <Rows>
      <Row>
        <span>scrollbar.size · {size.value}</span>
        <div ref={size.ref} {...stylex.props(styles.size)} />
      </Row>
      <Row>
        <span>scrollbar.inset · {inset.value}</span>
        <div ref={inset.ref} {...stylex.props(styles.inset)} />
      </Row>
      <Row>
        <span>scrollbar.compactSize · {compact.value}</span>
        <div ref={compact.ref} {...stylex.props(styles.compact)} />
      </Row>
      <Row>
        <span>scrollbar.radius · {radius.value}</span>
        <div ref={radius.ref} {...stylex.props(styles.radius)} />
      </Row>
    </Rows>
  );
}

export function ScrollAreaDemo() {
  const rows = Array.from({ length: 16 }, (_, index) => (
    <div key={index} {...stylex.props(styles.row)}>
      Workspace {index + 1}
    </div>
  ));
  return (
    <Rows>
      <ScrollArea
        {...stylex.props(styles.frame)}
        visibility="always"
        aria-label="Vertical scrollbar sample"
      >
        {rows}
      </ScrollArea>
      <ScrollArea
        {...stylex.props(styles.frame)}
        axis="both"
        aria-label="Two-axis scrollbar sample"
      >
        <div {...stylex.props(styles.wide)}>{rows}</div>
      </ScrollArea>
      <ScrollArea
        {...stylex.props(styles.frame, styles.compactFrame)}
        axis="horizontal"
        compact
        visibility="scroll"
        aria-label="Compact horizontal scrollbar sample"
      >
        <div {...stylex.props(styles.row, styles.wide)}>
          Workspace navigation · a compact track that appears while scrolling
        </div>
      </ScrollArea>
      <Dimensions />
      <Swatch name="scrollbar.thumb" value={scrollbar.thumb} note="rest" />
      <Swatch name="scrollbar.thumbHover" value={scrollbar.thumbHover} note="hover" />
      <Swatch name="scrollbar.thumbActive" value={scrollbar.thumbActive} note="pressed" />
    </Rows>
  );
}
