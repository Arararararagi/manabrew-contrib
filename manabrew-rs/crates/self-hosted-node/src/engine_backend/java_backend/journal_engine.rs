use super::*;
use std::cell::RefCell;
use std::rc::Rc;

#[derive(Clone)]
pub(super) struct JournalEngine {
    bridge: Rc<RefCell<SubprocessBridge>>,
}

impl JournalEngine {
    pub(super) fn spawn() -> Result<Self, String> {
        let config = JavaRuntimeConfig::from_env();
        #[cfg(feature = "java-forge")]
        let bridge = SubprocessBridge::spawn(&config)?;
        #[cfg(all(feature = "graal-forge", not(feature = "java-forge")))]
        let bridge = {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let mut command = Command::new(executable);
            command
                .arg("--forge-engine-worker")
                .arg(&config.assets_dir)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            SubprocessBridge::from_child(command.spawn().map_err(|error| error.to_string())?)?
        };
        Ok(Self {
            bridge: Rc::new(RefCell::new(bridge)),
        })
    }

    fn call(&self, command: &str, session: &str) -> Result<String, String> {
        self.bridge
            .borrow_mut()
            .call(&json!({"command": command, "sessionId": session}).to_string())
    }

    pub(super) fn start_game(&self, request: &str) -> Result<String, String> {
        let response = self.bridge.borrow_mut().start_game_json(request)?;
        serde_json::from_str::<StartGameResponse>(&response)
            .map(|response| response.session_id)
            .map_err(|error| error.to_string())
    }

    pub(super) fn submit_action(&self, session: &str, action: &str) -> Result<String, String> {
        self.bridge.borrow_mut().submit_action(session, action)
    }

    pub(super) fn get_prompt(
        &self,
        session: &str,
        player: usize,
    ) -> Result<Option<String>, String> {
        self.bridge.borrow_mut().get_prompt(session, player)
    }

    pub(super) fn get_snapshot(
        &self,
        session: &str,
        viewer: Option<usize>,
    ) -> Result<String, String> {
        self.bridge.borrow_mut().get_snapshot(session, viewer)
    }

    pub(super) fn is_game_over(&self, session: &str) -> Result<bool, String> {
        self.bridge.borrow_mut().is_game_over(session)
    }

    pub(super) fn state_revision(&self, session: &str) -> Result<u64, String> {
        self.bridge.borrow_mut().state_revision(session)
    }

    pub(super) fn drain_checkpoint_metrics(&self, session: &str) -> Result<String, String> {
        self.bridge.borrow_mut().drain_checkpoint_metrics(session)
    }

    pub(super) fn end_game(&self, session: &str) -> Result<(), String> {
        self.bridge.borrow_mut().end_game(session)
    }

    pub(super) fn abort_game(&self, session: &str) -> Result<(), String> {
        self.bridge.borrow_mut().abort_game(session)
    }

    #[cfg(all(feature = "graal-forge", not(feature = "java-forge")))]
    pub(super) fn gc_stats(&self) -> Result<GcStats, String> {
        serde_json::from_str(&self.call("gcStats", "")?).map_err(|error| error.to_string())
    }

    pub(super) fn rewind_if_requested(
        &self,
        session: &str,
        cancel: &AtomicBool,
    ) -> Result<Option<u32>, String> {
        let snapshot = self.call("getRewindRequest", session)?;
        if snapshot.is_empty() {
            return Ok(None);
        }
        let result = (|| {
            let snapshot: Value =
                serde_json::from_str(&snapshot).map_err(|error| error.to_string())?;
            let start = snapshot["journal"]["startRequest"]
                .as_str()
                .ok_or("rewind has no start request")?;
            let mut request: Value =
                serde_json::from_str(start).map_err(|error| error.to_string())?;
            let prompt_id = snapshot["prompt"]["promptId"]
                .as_u64()
                .and_then(|id| u32::try_from(id).ok())
                .ok_or("rewind has no target prompt")?;
            request["replaySnapshot"] = snapshot;
            let replacement = Self::spawn()?;
            if replacement.start_game(&request.to_string())? != session {
                return Err("rewind changed the game identity".to_string());
            }
            let deadline = Instant::now() + Duration::from_secs(120);
            loop {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err("rewind cancelled".to_string());
                }
                if replacement.call("replayReady", session)? == "true" {
                    serde_json::from_str::<GameViewDto>(&replacement.get_snapshot(session, None)?)
                        .map_err(|error| format!("invalid restored state: {error}"))?;
                    serde_json::from_str::<AgentPrompt>(
                        &replacement
                            .get_prompt(session, 0)?
                            .ok_or("no restored prompt")?,
                    )
                    .map_err(|error| format!("invalid restored prompt: {error}"))?;
                    self.bridge.swap(&replacement.bridge);
                    return Ok(prompt_id);
                }
                if Instant::now() >= deadline || replacement.is_game_over(session)? {
                    return Err("replay did not reach the selected decision".to_string());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        })();
        match result {
            Ok(prompt) => Ok(Some(prompt)),
            Err(error) => {
                warn!(%error, "journal rewind failed; keeping the current game");
                self.call("resumeAfterFailedRewind", session)?;
                Ok(None)
            }
        }
    }
}

#[cfg(feature = "graal-forge")]
pub(super) fn run_native_worker() -> ! {
    let result = (|| -> Result<(), String> {
        let assets = std::env::args()
            .nth(2)
            .ok_or("missing engine assets directory")?;
        let bridge = std::mem::ManuallyDrop::new(GraalBridge::create()?);
        let assets = cstring(&assets)?;
        bridge.decode(unsafe { graal_ffi::forge_initialize(bridge.thread, assets.as_ptr()) })?;
        let isolate = unsafe { graal_ffi::graal_get_isolate(bridge.thread) } as usize;
        std::thread::spawn(move || {
            let mut thread = std::ptr::null_mut();
            if unsafe { graal_ffi::graal_attach_thread(isolate as *mut _, &mut thread) } != 0 {
                return;
            }
            let sampler = GraalBridge {
                thread,
                attached: true,
            };
            loop {
                if let Ok(stats) = sampler.decode(unsafe { graal_ffi::forge_gc_stats(thread) }) {
                    eprintln!("forge:gc {stats}");
                }
                std::thread::sleep(ENGINE_GC_SAMPLE_INTERVAL);
            }
        });
        for line in std::io::stdin().lock().lines() {
            let line = line.map_err(|error| error.to_string())?;
            let response = (|| -> Result<String, String> {
                let request: Value =
                    serde_json::from_str(&line).map_err(|error| error.to_string())?;
                if request["command"] == "quit" {
                    std::process::exit(0);
                }
                if request["command"] == "gcStats" {
                    return bridge.decode(unsafe { graal_ffi::forge_gc_stats(bridge.thread) });
                }
                let request = cstring(&line)?;
                bridge.decode(unsafe { graal_ffi::forge_command(bridge.thread, request.as_ptr()) })
            })();
            let envelope = match response {
                Ok(result) => json!({"ok": true, "result": result}),
                Err(error) => json!({"ok": false, "error": error}),
            };
            println!("{envelope}");
        }
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("engine worker failed: {error}");
        std::process::exit(1);
    }
    std::process::exit(0);
}

#[cfg(feature = "graal-forge")]
pub(super) fn report_process_gc(process_id: u32, stats: Option<GcStats>) {
    static PROCESSES: std::sync::OnceLock<std::sync::Mutex<HashMap<u32, GcStats>>> =
        std::sync::OnceLock::new();
    let Ok(mut processes) = PROCESSES.get_or_init(Default::default).lock() else {
        return;
    };
    if let Some(stats) = stats {
        let previous = processes.get(&process_id);
        for (collector, current) in &stats.by_collector {
            let prior = previous.and_then(|stats| stats.by_collector.get(collector));
            crate::metrics::record_engine_gc_delta(
                collector,
                current
                    .collections
                    .saturating_sub(prior.map_or(0, |stats| stats.collections)),
                current
                    .pause_millis
                    .saturating_sub(prior.map_or(0, |stats| stats.pause_millis)),
            );
        }
        crate::metrics::record_engine_stall_delta(
            stats
                .stalled_millis
                .saturating_sub(previous.map_or(0, |stats| stats.stalled_millis)),
            stats
                .long_stalls
                .saturating_sub(previous.map_or(0, |stats| stats.long_stalls)),
        );
        processes.insert(process_id, stats);
    } else {
        processes.remove(&process_id);
    }
    crate::metrics::record_engine_gc(
        0,
        0,
        processes.values().map(|stats| stats.heap_used_bytes).sum(),
        processes.values().map(|stats| stats.heap_max_bytes).sum(),
    );
    crate::metrics::record_engine_stall(
        0,
        processes
            .values()
            .map(|stats| stats.max_stall_millis)
            .max()
            .unwrap_or(0),
        0,
    );
}
