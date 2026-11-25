use crate::actor::SessionHandle;
use lody_app::AttachedWorkspaceView;
use lody_ports::{
    PortError, PortErrorKind, PortResult, SessionId, WorkspaceId, WorkspaceSecurityMode,
};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Notify;

pub enum DetachDisposition {
    Absent,
    JoinedInFlight(Arc<Notify>),
    Started {
        session_ids: Vec<SessionId>,
        sessions: Vec<SessionHandle>,
        notify: Arc<Notify>,
    },
}

pub struct WorkspaceMount {
    pub workspace_id: WorkspaceId,
    pub security_mode: WorkspaceSecurityMode,
    pub detach_notify: Option<Arc<Notify>>,
    pub sessions: HashMap<SessionId, SessionHandle>,
}

impl WorkspaceMount {
    pub fn new(workspace_id: WorkspaceId, security_mode: WorkspaceSecurityMode) -> Self {
        Self {
            workspace_id,
            security_mode,
            detach_notify: None,
            sessions: HashMap::new(),
        }
    }

    pub fn is_draining(&self) -> bool {
        self.detach_notify.is_some()
    }

    pub fn view(&self) -> AttachedWorkspaceView {
        AttachedWorkspaceView {
            workspace_id: self.workspace_id.clone(),
            security_mode: self.security_mode.clone(),
            active_session_count: self.sessions.len(),
        }
    }
}

#[derive(Default)]
pub struct FleetWorkspaceTable {
    mounts: HashMap<WorkspaceId, WorkspaceMount>,
}

impl FleetWorkspaceTable {
    pub fn attach_or_update(
        &mut self,
        workspace_id: &WorkspaceId,
        mode: WorkspaceSecurityMode,
    ) -> PortResult<AttachedWorkspaceView> {
        if let Some(existing) = self.mounts.get_mut(workspace_id) {
            if existing.is_draining() {
                return Err(PortError::new(
                    PortErrorKind::Unavailable,
                    "workspace is currently detaching",
                ));
            }
            existing
                .security_mode
                .validate_transition(&mode)
                .map_err(|msg| PortError::new(PortErrorKind::Conflict, msg))?;
            existing.security_mode = mode;
            return Ok(existing.view());
        }

        let mount = WorkspaceMount::new(workspace_id.clone(), mode);
        let view = mount.view();
        self.mounts.insert(workspace_id.clone(), mount);
        Ok(view)
    }

    pub fn begin_detach(&mut self, workspace_id: &WorkspaceId) -> DetachDisposition {
        let Some(mount) = self.mounts.get_mut(workspace_id) else {
            return DetachDisposition::Absent;
        };
        if let Some(existing_notify) = &mount.detach_notify {
            return DetachDisposition::JoinedInFlight(Arc::clone(existing_notify));
        }
        let notify = Arc::new(Notify::new());
        mount.detach_notify = Some(Arc::clone(&notify));
        let mut session_ids = Vec::with_capacity(mount.sessions.len());
        let mut sessions = Vec::with_capacity(mount.sessions.len());
        for (sid, handle) in mount.sessions.drain() {
            session_ids.push(sid);
            sessions.push(handle);
        }
        DetachDisposition::Started {
            session_ids,
            sessions,
            notify,
        }
    }

    pub fn finish_detach(&mut self, workspace_id: &WorkspaceId) {
        self.mounts.remove(workspace_id);
    }

    pub fn drain_all(&mut self) -> Vec<SessionHandle> {
        let mut all = Vec::new();
        for (_, mut mount) in self.mounts.drain() {
            all.extend(mount.sessions.drain().map(|(_, h)| h));
        }
        all
    }

    pub fn get_session(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
    ) -> Option<SessionHandle> {
        self.mounts.get(workspace_id).and_then(|m| {
            (!m.is_draining())
                .then(|| m.sessions.get(session_id).cloned())
                .flatten()
        })
    }

    pub fn find_session_by_id(
        &self,
        session_id: &SessionId,
    ) -> Option<(WorkspaceId, SessionHandle)> {
        for (ws_id, mount) in &self.mounts {
            if !mount.is_draining()
                && let Some(handle) = mount.sessions.get(session_id)
            {
                return Some((ws_id.clone(), handle.clone()));
            }
        }
        None
    }

    pub fn remove_session(
        &mut self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
    ) -> Option<SessionHandle> {
        self.mounts
            .get_mut(workspace_id)
            .and_then(|m| m.sessions.remove(session_id))
    }

    pub fn list_views(&self) -> Vec<AttachedWorkspaceView> {
        let mut out: Vec<AttachedWorkspaceView> = self
            .mounts
            .values()
            .filter(|m| !m.is_draining())
            .map(WorkspaceMount::view)
            .collect();
        out.sort_by(|a, b| a.workspace_id.cmp(&b.workspace_id));
        out
    }

    pub fn get_or_insert_mount(
        &mut self,
        workspace_id: &WorkspaceId,
        default_mode: WorkspaceSecurityMode,
    ) -> PortResult<&mut WorkspaceMount> {
        if !self.mounts.contains_key(workspace_id) {
            self.mounts.insert(
                workspace_id.clone(),
                WorkspaceMount::new(workspace_id.clone(), default_mode),
            );
        }
        let mount = self.mounts.get_mut(workspace_id).expect("mount inserted");
        if mount.is_draining() {
            return Err(PortError::new(
                PortErrorKind::Unavailable,
                "workspace is currently detaching",
            ));
        }
        Ok(mount)
    }
}
