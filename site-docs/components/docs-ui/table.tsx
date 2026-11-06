import * as stylex from '@stylexjs/stylex';
import type { ComponentProps } from 'react';

const styles = stylex.create({
  scroll: {
    position: 'relative',
    overflow: 'auto',
    marginBlock: 'calc(var(--spacing) * 6)',
    ':is(*) > :first-child': { marginTop: 0 },
    ':is(*) > :last-child': { marginBottom: 0 },
  },
});

export function Table(props: ComponentProps<'table'>) {
  return (
    <div {...stylex.props(styles.scroll)}>
      <table {...props} />
    </div>
  );
}
