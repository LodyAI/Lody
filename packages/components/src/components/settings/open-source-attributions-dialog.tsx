import { useEffect, useRef, useState } from 'react';
import { Boxes, ExternalLink, FileCode2, FolderTree, Palette, ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { OPEN_SOURCE_ATTRIBUTION_BUNDLE } from '@/lib/open-source-attributions.generated';
import type { OpenSourceAttributionEntry } from '@/lib/open-source-attributions';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui';

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
    <div className="rounded-md border border-border/70 bg-card/70 p-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="mt-2 text-lg font-semibold text-foreground">{value}</div>
    </div>
  );
}

function AttributionItem({ entry }: { entry: OpenSourceAttributionEntry }) {
  return (
    <div className="rounded-md border border-border/70 bg-card/60 p-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-foreground">{entry.name}</p>
            <Badge variant="secondary" className="rounded-md">
              {entry.license}
            </Badge>
            {entry.scope === 'bundled-theme' ? (
              <Badge variant="outline" className="rounded-md">
                Theme
              </Badge>
            ) : null}
            {entry.scope === 'vendored-icon-set' ? (
              <Badge variant="outline" className="rounded-md">
                Icons
              </Badge>
            ) : null}
          </div>
          {entry.versions?.length ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Versions: {entry.versions.join(', ')}
            </p>
          ) : null}
          {entry.assets?.length ? (
            <p className="mt-1 text-xs text-muted-foreground">Assets: {entry.assets.join(', ')}</p>
          ) : null}
          {entry.author ? (
            <p className="mt-1 text-xs text-muted-foreground">Author: {entry.author}</p>
          ) : null}
          {entry.description ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {entry.description}
            </p>
          ) : null}
          {entry.noticePath ? (
            <p className="mt-1 text-xs text-muted-foreground">Notice file: {entry.noticePath}</p>
          ) : null}
        </div>
        {entry.homepage ? (
          <a
            href={entry.homepage}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-hover-foreground"
          >
            Source
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null}
      </div>
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
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) clearOpenTimer();
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger asChild>
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
        >
          <ScrollText className="mr-1 h-3.5 w-3.5" />
          {t('settings.about.viewAttributions', 'View notices')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-5xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-4 py-4 sm:px-6">
          <DialogTitle>
            {t('settings.about.openSourceAttributions', 'Open Source Licenses')}
          </DialogTitle>
          <DialogDescription>
            {t('settings.about.generatedAt', 'Generated at')}: {generatedAtLabel}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 border-b border-border/70 px-4 py-4 sm:grid-cols-3 sm:px-6">
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

        <ScrollArea className="max-h-[70vh]">
          <div className="px-4 py-4 sm:px-6">
            <Accordion type="multiple" defaultValue={['bundled-assets']} className="w-full">
              <AccordionItem value="bundled-assets">
                <AccordionTrigger className="py-3 text-sm">
                  <span className="flex items-center gap-2">
                    <Palette className="h-4 w-4 text-muted-foreground" />
                    {t('settings.about.bundledAssets', 'Bundled assets')}
                    <Badge variant="secondary" className="rounded-md">
                      {bundledEntries.length}
                    </Badge>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-3">
                    {bundledEntries.map((entry) => (
                      <AttributionItem key={entry.id} entry={entry} />
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="dependencies">
                <AccordionTrigger className="py-3 text-sm">
                  <span className="flex items-center gap-2">
                    <FileCode2 className="h-4 w-4 text-muted-foreground" />
                    {t('settings.about.dependencies', 'Dependencies')}
                    <Badge variant="secondary" className="rounded-md">
                      {dependencyEntries.length}
                    </Badge>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-3">
                    <div className="flex flex-col gap-2 rounded-md border border-border/70 bg-card/60 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">
                          {t('settings.about.licenseGroup', 'License group')}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t(
                            'settings.about.licenseGroupHelper',
                            'Showing one license expression at a time to keep the list usable.'
                          )}
                        </p>
                      </div>
                      <Select
                        value={selectedDependencyLicense}
                        onValueChange={setSelectedDependencyLicense}
                      >
                        <SelectTrigger className="w-full sm:w-[320px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {dependencyLicenseOptions.map((option) => (
                            <SelectItem key={option.license} value={option.license}>
                              {option.license} ({option.count})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {selectedDependencyEntries.map((entry) => (
                      <AttributionItem key={entry.id} entry={entry} />
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
