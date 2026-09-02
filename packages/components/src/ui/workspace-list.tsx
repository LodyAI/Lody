import * as React from 'react';
import { Cloud, LogIn, CloudOff, Upload, MoreHorizontal, Plus, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import { Separator } from './separator';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';

export interface WorkspaceItem {
  id: string;
  title: string;
  path: string;
  icon?: React.ReactNode;
  isCloud?: boolean;
  isSelected?: boolean;
}

export interface WorkspaceListProps extends React.HTMLAttributes<HTMLDivElement> {
  accountName?: string;
  activeWorkspace?: WorkspaceItem;
  workspaces?: WorkspaceItem[];
  onNewWorkspace?: () => void;
  onWorkspaceSelect?: (workspace: WorkspaceItem) => void;
  onWorkspaceSettings?: (workspace: WorkspaceItem) => void;
  onWorkspaceRename?: (workspace: WorkspaceItem) => void;
  onWorkspaceDelete?: (workspace: WorkspaceItem) => void;
  onSignIn?: () => void;
  onUpload?: () => void;
  onAppSettings?: () => void;
  isSignedIn?: boolean;
}

// Reusable WorkspaceIcon component
interface WorkspaceIconProps {
  title?: string;
  icon?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xs';
}

export const WorkspaceIcon: React.FC<WorkspaceIconProps> = ({ title, icon, size = 'md' }) => {
  const sizeClasses = {
    xs: 'w-5 h-5 min-w-5 text-xs',
    sm: 'w-7 h-7 min-w-7 text-sm',
    md: 'w-10 h-10 text-lg',
    lg: 'w-12 h-12 text-xl',
  };

  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-md bg-sidebar-hover text-sidebar-foreground-muted font-medium',
        sizeClasses[size]
      )}
    >
      {icon || title?.charAt(0).toUpperCase()}
    </div>
  );
};

// Reusable ActionButton component
interface ActionButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  variant?: 'secondary' | 'ghost';
  className?: string;
  title?: string;
}

const ActionButton: React.FC<ActionButtonProps> = ({
  icon,
  label,
  onClick,
  variant = 'secondary',
  className,
  title,
}) => {
  return (
    <Button
      variant={variant}
      className={cn('flex-1 flex', className)}
      onClick={onClick}
      title={title}
    >
      {icon}
      {label}
    </Button>
  );
};

// Reusable WorkspaceItemRow component
interface WorkspaceItemRowProps {
  workspace: WorkspaceItem;
  onSelect?: (workspace: WorkspaceItem) => void;
  onRename?: (workspace: WorkspaceItem) => void;
  onSettings?: (workspace: WorkspaceItem) => void;
  onDelete?: (workspace: WorkspaceItem) => void;
  showMoreMenu?: boolean;
}

const WorkspaceItemRow: React.FC<WorkspaceItemRowProps> = ({
  workspace,
  onSelect,
  onRename,
  onSettings,
  onDelete,
  showMoreMenu = true,
}) => {
  const { t } = useTranslation();

  return (
    <div
      className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-hover cursor-pointer group relative"
      onClick={() => onSelect?.(workspace)}
    >
      <WorkspaceIcon title={workspace.title} icon={workspace.icon} size="sm" />
      <div className="flex-1 overflow-hidden">
        <div className="truncate text-sm">{workspace.title}</div>
        <div className="text-xs text-muted-foreground truncate">{workspace.path}</div>
      </div>

      {showMoreMenu && (
        <div className="absolute right-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="mini" icon>
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">More options</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onRename?.(workspace)}>
                {t('workspace.rename')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSettings?.(workspace)}>
                {t('workspace.settings')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onDelete?.(workspace)}
                className="text-destructive focus:text-destructive"
              >
                {t('workspace.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
};

// Reusable SimpleActionRow component
interface SimpleActionRowProps {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  className?: string;
}

const SimpleActionRow: React.FC<SimpleActionRowProps> = ({ icon, label, onClick, className }) => {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-2 rounded-md hover:bg-hover cursor-pointer',
        className
      )}
      onClick={onClick}
    >
      {icon && (
        <div className="flex items-center justify-center w-7 h-7 min-w-7 rounded-xs text-muted-foreground font-medium">
          {icon}
        </div>
      )}
      <div className="flex-1 truncate text-muted-foreground text-sm">{label}</div>
    </div>
  );
};

// Reusable ScrollableWorkspaceList component
interface ScrollableWorkspaceListProps {
  workspaces: WorkspaceItem[];
  onWorkspaceSelect?: (workspace: WorkspaceItem) => void;
  onWorkspaceRename?: (workspace: WorkspaceItem) => void;
  onWorkspaceSettings?: (workspace: WorkspaceItem) => void;
  onWorkspaceDelete?: (workspace: WorkspaceItem) => void;
  showGradient?: boolean;
}

const ScrollableWorkspaceList: React.FC<ScrollableWorkspaceListProps> = ({
  workspaces,
  onWorkspaceSelect,
  onWorkspaceRename,
  onWorkspaceSettings,
  onWorkspaceDelete,
  showGradient = true,
}) => {
  return (
    <div
      className={cn(
        'max-h-[calc((100vh-450px)/2)] overflow-y-auto relative scrollbar-thin scrollbar-thumb-muted-foreground scrollbar-track-transparent hover:scrollbar-thumb-muted-foreground/80',
        workspaces.length === 0 ? '' : workspaces.length === 1 ? 'min-h-[45px]' : 'min-h-[60px]'
      )}
    >
      {showGradient && (
        <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-background to-transparent pointer-events-none" />
      )}
      {workspaces.map((workspace) => (
        <WorkspaceItemRow
          key={workspace.id}
          workspace={workspace}
          onSelect={onWorkspaceSelect}
          onRename={onWorkspaceRename}
          onSettings={onWorkspaceSettings}
          onDelete={onWorkspaceDelete}
        />
      ))}
    </div>
  );
};

const WorkspaceList = React.forwardRef<HTMLDivElement, WorkspaceListProps>(
  (
    {
      className,
      accountName,
      activeWorkspace,
      workspaces = [],
      onNewWorkspace,
      onWorkspaceSelect,
      onWorkspaceSettings,
      onWorkspaceRename,
      onWorkspaceDelete,
      onSignIn,
      onUpload,
      onAppSettings,
      isSignedIn = !!accountName,
      ...props
    },
    ref
  ) => {
    const { t } = useTranslation();

    return (
      <div
        ref={ref}
        className={cn(
          'flex flex-col w-[300px] bg-background text-foreground p-3 pb-2 overflow-auto',
          className
        )}
        {...props}
      >
        {/* Active Workspace */}
        {activeWorkspace && (
          <div className="space-y-3 mb-2">
            <div className="flex items-center gap-2">
              <WorkspaceIcon title={activeWorkspace.title} icon={activeWorkspace.icon} size="md" />
              <div className="flex flex-col">
                <div className="font-medium flex items-center gap-2">
                  {activeWorkspace.title}
                  <div
                    className="flex items-center justify-center hover:bg-hover rounded-xs p-1 cursor-pointer"
                    title={
                      activeWorkspace.isCloud
                        ? t('workspace.onCloudAndLocal')
                        : t('workspace.onPureLocal')
                    }
                  >
                    {activeWorkspace.isCloud ? (
                      <Cloud className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <CloudOff className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>
                </div>
                {activeWorkspace.isCloud && isSignedIn && accountName && (
                  <div className="text-xs text-muted-foreground truncate max-w-[180px]">
                    {accountName}
                  </div>
                )}
                <div className="text-xs text-muted-foreground truncate max-w-[180px]">
                  {activeWorkspace.path}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {!isSignedIn && onSignIn && (
                <ActionButton
                  icon={<LogIn className="w-3 h-3 mr-1" />}
                  label={t('workspace.signIn')}
                  onClick={onSignIn}
                  className="text-sm"
                />
              )}

              <ActionButton
                icon={<Settings className="w-3 h-3 mr-1" />}
                label={t('settings.title')}
                onClick={onAppSettings}
              />

              {!activeWorkspace.isCloud && isSignedIn && onUpload && (
                <ActionButton
                  icon={<Upload className="w-3 h-3 mr-1" />}
                  label={t('workspace.upload')}
                  onClick={onUpload}
                  title={t('workspace.uploadExplain')}
                />
              )}
            </div>
          </div>
        )}

        <Separator className="mt-2 mb-3" />

        {isSignedIn && (
          <div className="">
            {/* Account Section */}
            {isSignedIn && accountName && (
              <div className="mb-2">
                <div className="flex items-center text-sm font-medium text-muted-foreground pl-2">
                  {accountName}
                </div>
              </div>
            )}

            {/* Remote workspaces */}
            {workspaces.length > 0 && (
              <div className="">
                <ScrollableWorkspaceList
                  workspaces={workspaces}
                  onWorkspaceSelect={onWorkspaceSelect}
                  onWorkspaceRename={onWorkspaceRename}
                  onWorkspaceSettings={onWorkspaceSettings}
                  onWorkspaceDelete={onWorkspaceDelete}
                />
              </div>
            )}

            {/* New workspace button for signed-in users */}
            {isSignedIn && onNewWorkspace && (
              <SimpleActionRow
                className="mt-1"
                icon={<Plus className="w-3 h-3" />}
                label={t('workspace.newWorkspace')}
                onClick={onNewWorkspace}
              />
            )}
          </div>
        )}

        {isSignedIn && <Separator className="mb-3 mt-2" />}
      </div>
    );
  }
);

WorkspaceList.displayName = 'WorkspaceList';

export { WorkspaceList };
