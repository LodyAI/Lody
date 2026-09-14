import { useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Image as ImageIcon, ListTodo, Plus, Table2 } from 'lucide-react';
import { Spinner } from '@/ui/spinner';
import { useEditor } from '@prosekit/react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { tasksMenuClassName, tasksMenuSurfaceStyle } from './tasks-surface';

type InsertCommands = {
  focus?: () => void;
  insertText?: (options: { text: string }) => void;
  insertTable?: (options: { row: number; col: number; header: boolean }) => void;
  wrapInSquareTask?: () => void;
};

const escapeMarkdownAlt = (value: string): string => value.replaceAll(/[\\\]]/gu, '\\$&');

export function TaskBodyInsertMenu({
  onImagePaste,
  imageAccept,
}: {
  onImagePaste?: (file: File) => Promise<string | undefined>;
  imageAccept?: string;
}) {
  const { t } = useTranslation();
  const editor = useEditor();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const commands = editor?.commands as InsertCommands | undefined;

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (!onImagePaste || files.length === 0) return;

    setUploading(true);
    try {
      for (const file of files) {
        const destination = await onImagePaste(file);
        if (!destination) continue;
        editor?.focus();
        commands?.insertText?.({
          text: `![${escapeMarkdownAlt(file.name)}](${destination})`,
        });
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('tasks.images.uploadFailed', 'Upload failed')
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="absolute -left-7 top-1 z-[2]">
      <input
        ref={inputRef}
        type="file"
        accept={imageAccept}
        multiple
        hidden
        onChange={(event) => {
          void handleFiles(event);
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={uploading}
            aria-label={t('tasks.body.insert', 'Insert block')}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover/body:opacity-100"
          >
            {uploading ? <Spinner className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="bottom"
          className={tasksMenuClassName()}
          style={tasksMenuSurfaceStyle}
        >
          {onImagePaste ? (
            <DropdownMenuItem onSelect={() => inputRef.current?.click()}>
              <ImageIcon className="h-4 w-4" />
              {t('tasks.body.insertImage', 'Image')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onSelect={() => {
              editor?.focus();
              commands?.wrapInSquareTask?.();
            }}
          >
            <ListTodo className="h-4 w-4" />
            {t('tasks.body.insertTodo', 'To-do list')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              editor?.focus();
              commands?.insertTable?.({ row: 3, col: 3, header: true });
            }}
          >
            <Table2 className="h-4 w-4" />
            {t('tasks.body.insertTable', 'Table')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
