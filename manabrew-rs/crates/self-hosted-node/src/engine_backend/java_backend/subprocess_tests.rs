use super::*;

fn worker(script: &str) -> SubprocessBridge {
    let child = Command::new("python3")
        .args(["-u", "-c", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    SubprocessBridge::from_child(child).unwrap()
}

fn assert_reaped(pid: u32) {
    assert!(
        !Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success(),
        "orphaned worker {pid}"
    );
}

#[test]
fn blocked_stdin_is_timed_out_and_reaped() {
    let mut bridge = worker("import time; time.sleep(60)");
    let pid = bridge.child.id();
    bridge.deadline = Some(Instant::now() + Duration::from_millis(150));
    let start = Instant::now();
    assert!(bridge
        .call(&"x".repeat(2 * 1024 * 1024))
        .unwrap_err()
        .contains("timed out"));
    assert!(bridge.call("{}").unwrap_err().contains("closed"));
    drop(bridge);
    assert!(start.elapsed() < Duration::from_secs(3));
    assert_reaped(pid);
}

#[test]
fn replacement_rpc_hangs_and_exits_are_bounded() {
    for command in [
        "startGame",
        "replayReady",
        "getSnapshot",
        "getPrompt",
        "getGameOver",
    ] {
        for script in [
            "import sys,time; sys.stdin.readline(); time.sleep(60)",
            "import sys; sys.stdin.readline(); sys.exit(7)",
        ] {
            let mut bridge = worker(script);
            let pid = bridge.child.id();
            bridge.deadline = Some(Instant::now() + Duration::from_millis(150));
            let start = Instant::now();
            assert!(bridge
                .call(&json!({"command": command}).to_string())
                .is_err());
            assert!(bridge.failed);
            drop(bridge);
            assert!(start.elapsed() < Duration::from_secs(3), "{command}");
            assert_reaped(pid);
        }
    }
}

#[test]
fn cancellation_interrupts_blocked_rpc() {
    let mut bridge = worker("import time; time.sleep(60)");
    let cancel = Arc::new(AtomicBool::new(false));
    bridge.cancel = Some(Arc::clone(&cancel));
    let trigger = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    });
    let start = Instant::now();
    assert!(bridge.call("{}").unwrap_err().contains("cancelled"));
    drop(bridge);
    trigger.join().unwrap();
    assert!(start.elapsed() < Duration::from_secs(3));
}

#[test]
fn full_stdout_queue_does_not_deadlock_drop() {
    let bridge = worker("import time; print('noise\\n'*10000, flush=True); time.sleep(60)");
    let pid = bridge.child.id();
    std::thread::sleep(Duration::from_millis(150));
    let start = Instant::now();
    drop(bridge);
    assert!(start.elapsed() < Duration::from_secs(3));
    assert_reaped(pid);
}

#[test]
fn application_error_does_not_poison_transport() {
    let mut bridge = worker("import sys,json\nfor i,line in enumerate(sys.stdin):\n print(json.dumps({'ok':i>0,'error':'replay divergence','result':'resumed'}),flush=True)");
    assert_eq!(bridge.call("{}").unwrap_err(), "replay divergence");
    assert_eq!(bridge.call("{}").unwrap(), "resumed");
}
