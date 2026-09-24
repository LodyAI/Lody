import { useEffect, useRef, useState } from 'react';
import { Boxes, ExternalLink, FileCode2, FolderTree, Palette, ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { OPEN_SOURCE_ATTRIBUTION_BUNDLE } from '@/lib/open-source-attributions.generated';
import type { OpenSourceAttributionEntry } from '@/lib/open-source-attributions';
import { Badge, Button, ScrollArea, Dialog } from '@/ui';
import { Accordion } from '@lody/ui/accordion';
import { Select } from '@lody/ui/select';

const allEntries = OPEN_SOURCE_ATTRIBUTION_BUNDLE.entries;
const bundledEntries = allEntries.filter((entry) => entry.kind === 'vendored');
const dependencyEntries = allEntries.filter((entry) => entry.kind === 'package');
const uniqueLicenses = new Set(allEntries.map((entry) => entry.license)).size;
const generatedAtLabel = formatGeneratedAt(OPEN_SOURCE_ATTRIBUTION_BUNDLE.generatedAt);
const dependencyEntriesByLicense = groupBy(dependencyEntries, (entry) => entry.license);
const dependencyLicenseOptions = Object.entries(dependencyEntriesByLicense)
  .map(([license, entries]) => ({ license, count: entries.length }))
  .sort(
    (left, right) =>
      right.count - left.count ||
      left.license.localeCompare(right.license, undefined, { sensitivity: 'base' })
  );
const defaultDependencyLicense = dependencyLicenseOptions[0]?.license ?? '';
// `Select.Value` reads the label of the current value from `items`, not from
// the rows, so the list is stated once and drives both.
const dependencyLicenseItems = dependencyLicenseOptions.map((option) => ({
  value: option.license,
  label: `${option.license} (${option.count})`,
}));

const WIDE = '@media (min-width: 640px)';
/** A block inside the modal panel: the region rung, a fill with no edge. */
const REGION = `color-mix(in oklab, transparent, ${colors.label} 3%)`;

/**
 * The panel's own width: a license list reads as a table of names and notes, so
 * it takes a wider panel than a question does. The panel keeps its own cap
 * against the window.
 */
const PANEL_STYLE = { width: '1024px' } as const;

const styles = stylex.create({
  summary: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr', [WIDE]: 'repeat(3, minmax(0, 1fr))' },
    gap: space[3],
  },
  summaryCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    padding: space[3],
    backgroundColor: REGION,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
  summaryLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  summaryValue: { fontSize: text.titleSize, fontWeight: 400, color: colors.label },
  icon: { width: '16px', height: '16px', flexShrink: 0, color: colors.tertiaryLabel },
  smallIcon: { width: '14px', height: '14px', flexShrink: 0 },
  scroll: { maxHeight: '70vh', minHeight: 0 },
  triggerLabel: { display: 'flex', alignItems: 'center', gap: space[2] },
  panelBody: { display: 'flex', flexDirection: 'column', gap: space[3] },
  /** The records are one list: a region of the panel, its rows ruled apart. */
  list: {
    overflow: 'hidden',
    backgroundColor: REGION,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
  item: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: space[2],
    padding: space[3],
  },
  itemRuled: { boxShadow: `inset 0 1px 0 ${colors.separator}` },
  itemText: { flexGrow: 1, flexBasis: 0, minWidth: 0 },
  itemHeading: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  itemName: { margin: 0, fontSize: text.bodySize, fontWeight: 400, color: colors.label },
  itemMeta: {
    margin: 0,
    marginTop: space[1],
    fontSize: text.footnoteSize,
    lineHeight: 1.5,
    color: colors.secondaryLabel,
  },
  licenseGroup: {
    display: 'flex',
    flexDirection: { default: 'column', [WIDE]: 'row' },
    alignItems: { default: 'stretch', [WIDE]: 'center' },
    justifyContent: 'space-between',
    gap: space[2],
  },
  licenseGroupText: { minWidth: 0 },
  licenseGroupTitle: { margin: 0, fontSize: text.bodySize, fontWeight: 400, color: colors.label },
  licenseGroupHint: { margin: 0, fontSize: text.footnoteSize, color: colors.secondaryLabel },
  licenseSelect: { flexShrink: 0, width: { default: '100%', [WIDE]: '320px' } },
});

function formatGeneratedAt(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function SummaryCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Boxes;
  label: string;
  value: string;
}) {
  return (
    <div {...stylex.props(styles.summaryCard)}>
      <div {...stylex.props(styles.summaryLabel)}>
        <Icon {...stylex.props(styles.icon)} />
        <span>{label}</span>
      </div>
      <div {...stylex.props(styles.summaryValue)}>{value}</div>
    </div>
  );
}

function AttributionItem({ entry, ruled }: { entry: OpenSourceAttributionEntry; ruled: boolean }) {
  return (
    <div {...stylex.props(styles.item, ruled && styles.itemRuled)}>
      <div {...stylex.props(styles.itemText)}>
        <div {...stylex.props(styles.itemHeading)}>
          <p {...stylex.props(styles.itemName)}>{entry.name}</p>
          <Badge>{entry.license}</Badge>
          {entry.scope === 'bundled-theme' ? <Badge>Theme</Badge> : null}
          {entry.scope === 'vendored-icon-set' ? <Badge>Icons</Badge> : null}
        </div>
        {entry.versions?.length ? (
          <p {...stylex.props(styles.itemMeta)}>Versions: {entry.versions.join(', ')}</p>
        ) : null}
        {entry.assets?.length ? (
          <p {...stylex.props(styles.itemMeta)}>Assets: {entry.assets.join(', ')}</p>
        ) : null}
        {entry.author ? <p {...stylex.props(styles.itemMeta)}>Author: {entry.author}</p> : null}
        {entry.description ? <p {...stylex.props(styles.itemMeta)}>{entry.description}</p> : null}
        {entry.noticePath ? (
          <p {...stylex.props(styles.itemMeta)}>Notice file: {entry.noticePath}</p>
        ) : null}
      </div>
      {entry.homepage ? (
        <Button
          variant="ghost"
          size="mini"
          nativeButton={false}
          render={<a href={entry.homepage} target="_blank" rel="noreferrer" />}
        >
          Source
          <ExternalLink {...stylex.props(styles.smallIcon)} />
        </Button>
      ) : null}
    </div>
  );
}

function AttributionList({ entries }: { entries: OpenSourceAttributionEntry[] }) {
  return (
    <div {...stylex.props(styles.list)}>
      {entries.map((entry, index) => (
        <AttributionItem key={entry.id} entry={entry} ruled={index > 0} />
      ))}
    </div>
  );
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};

  for (const item of items) {
    const key = getKey(item);
    groups[key] ??= [];
    groups[key].push(item);
  }

  return groups;
}

export function OpenSourceAttributionsDialog({
  onTriggerDoubleClick,
}: {
  onTriggerDoubleClick?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [selectedDependencyLicense, setSelectedDependencyLicense] =
    useState(defaultDependencyLicense);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedDependencyEntries =
    dependencyEntriesByLicense[selectedDependencyLicense] ?? dependencyEntries;

  const clearOpenTimer = () => {
    if (!openTimerRef.current) return;
    clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  };

  useEffect(() => clearOpenTimer, []);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) clearOpenTimer();
        setOpen(nextOpen);
      }}
    >
      <Dialog.Trigger
        render={
          <Button
            variant="secondary"
            size="small"
            onClick={(event) => {
              event.preventDefault();
              clearOpenTimer();
              openTimerRef.current = setTimeout(() => {
                openTimerRef.current = null;
                setOpen(true);
              }, 400);
            }}
            onDoubleClick={(event) => {
              event.preventDefault();
              clearOpenTimer();
              onTriggerDoubleClick?.();
            }}
          />
        }
      >
        <ScrollText {...stylex.props(styles.smallIcon)} />
        {t('settings.about.viewAttributions', 'View notices')}
      </Dialog.Trigger>
      <Dialog.Content style={PANEL_STYLE}>
        <Dialog.Header>
          <Dialog.Title>
            {t('settings.about.openSourceAttributions', 'Open Source Licenses')}
          </Dialog.Title>
          <Dialog.Description>
            {t('settings.about.generatedAt', 'Generated at')}: {generatedAtLabel}
          </Dialog.Description>
        </Dialog.Header>

        <div {...stylex.props(styles.summary)}>
          <SummaryCard
            icon={Boxes}
            label={t('settings.about.dependencies', 'Dependencies')}
            value={String(dependencyEntries.length)}
          />
          <SummaryCard
            icon={Palette}
            label={t('settings.about.bundledAssets', 'Bundled assets')}
            value={String(bundledEntries.length)}
          />
          <SummaryCard
            icon={FolderTree}
            label={t('settings.about.licenses', 'Licenses')}
            value={String(uniqueLicenses)}
          />
        </div>

        <ScrollArea {...stylex.props(styles.scroll)}>
          <Accordion.Root multiple defaultValue={['bundled-assets']}>
            <Accordion.Item value="bundled-assets">
              <Accordion.Trigger>
                <span {...stylex.props(styles.triggerLabel)}>
                  <Palette {...stylex.props(styles.icon)} />
                  {t('settings.about.bundledAssets', 'Bundled assets')}
                  <Badge>{bundledEntries.length}</Badge>
                </span>
              </Accordion.Trigger>
              <Accordion.Panel>
                <AttributionList entries={bundledEntries} />
              </Accordion.Panel>
            </Accordion.Item>

            <Accordion.Item value="dependencies">
              <Accordion.Trigger>
                <span {...stylex.props(styles.triggerLabel)}>
                  <FileCode2 {...stylex.props(styles.icon)} />
                  {t('settings.about.dependencies', 'Dependencies')}
                  <Badge>{dependencyEntries.length}</Badge>
                </span>
              </Accordion.Trigger>
              <Accordion.Panel>
                <div {...stylex.props(styles.panelBody)}>
                  <div {...stylex.props(styles.licenseGroup)}>
                    <div {...stylex.props(styles.licenseGroupText)}>
                      <p {...stylex.props(styles.licenseGroupTitle)}>
                        {t('settings.about.licenseGroup', 'License group')}
                      </p>
                      <p {...stylex.props(styles.licenseGroupHint)}>
                        {t(
                          'settings.about.licenseGroupHelper',
                          'Showing one license expression at a time to keep the list usable.'
                        )}
                      </p>
                    </div>
                    <Select.Root
                      items={dependencyLicenseItems}
                      value={selectedDependencyLicense}
                      onValueChange={(value) => {
                        if (value != null) setSelectedDependencyLicense(value);
                      }}
                    >
                      <div {...stylex.props(styles.licenseSelect)}>
                        <Select.Trigger>
                          <Select.Value />
                        </Select.Trigger>
                      </div>
                      <Select.Content>
                        {dependencyLicenseItems.map((option) => (
                          <Select.Item key={option.value} value={option.value}>
                            {option.label}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                  </div>
                  <AttributionList entries={selectedDependencyEntries} />
                </div>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion.Root>
        </ScrollArea>
      </Dialog.Content>
    </Dialog.Root>
  );
}
