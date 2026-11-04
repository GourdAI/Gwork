package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

class FileChangeBoundaryTest {
    @Test
    void failedFinishReleasesGuardForFinallyRetry() {
        AtomicBoolean guard = new AtomicBoolean();
        AtomicInteger calls = new AtomicInteger();

        Assertions.assertFalse(WebGate.finishOnce(guard, () -> {
            calls.incrementAndGet();
            return false;
        }));
        Assertions.assertFalse(guard.get());
        Assertions.assertTrue(WebGate.finishOnce(guard, () -> {
            calls.incrementAndGet();
            return true;
        }));
        Assertions.assertTrue(guard.get());
        Assertions.assertEquals(2, calls.get());
        Assertions.assertFalse(WebGate.finishOnce(guard, () -> {
            calls.incrementAndGet();
            return true;
        }));
        Assertions.assertEquals(2, calls.get());
    }

    @Test
    void concurrentFinishGuardAllowsOnlyOneAttempt() throws Exception {
        AtomicBoolean guard = new AtomicBoolean();
        AtomicInteger active = new AtomicInteger();
        AtomicInteger maxActive = new AtomicInteger();
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);

        Thread first = new Thread(() -> WebGate.finishOnce(guard, () -> {
            maxActive.accumulateAndGet(active.incrementAndGet(), Math::max);
            entered.countDown();
            try {
                release.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                active.decrementAndGet();
            }
            return true;
        }));
        first.start();
        entered.await();
        Assertions.assertFalse(WebGate.finishOnce(guard, () -> {
            maxActive.accumulateAndGet(active.incrementAndGet(), Math::max);
            active.decrementAndGet();
            return true;
        }));
        release.countDown();
        first.join();
        Assertions.assertEquals(1, maxActive.get());
    }

    @Test
    void boundRootCannotBeOverriddenByRequestOrHeader() throws Exception {
        Path bound = Files.createTempDirectory("changes-bound");
        Path other = Files.createTempDirectory("changes-other");
        try {
            Assertions.assertEquals(bound.toRealPath().toString(), WebController.resolveChangeRoot(
                    bound.toString(), bound.toString(), bound.toString(), other.toString(), value -> value));
            Assertions.assertThrows(IllegalArgumentException.class, () -> WebController.resolveChangeRoot(
                    bound.toString(), other.toString(), null, bound.toString(), value -> value));
            Assertions.assertThrows(IllegalArgumentException.class, () -> WebController.resolveChangeRoot(
                    bound.toString(), null, other.toString(), bound.toString(), value -> value));
        } finally {
            Files.deleteIfExists(other);
            Files.deleteIfExists(bound);
        }
    }

    @Test
    void unboundSessionAcceptsOnlyWorkspaceOrRegisteredProject() throws Exception {
        Path workspace = Files.createTempDirectory("changes-workspace");
        Path project = Files.createTempDirectory("changes-project");
        Path arbitrary = Files.createTempDirectory("changes-arbitrary");
        try {
            Assertions.assertEquals(workspace.toRealPath().toString(), WebController.resolveChangeRoot(
                    null, null, null, workspace.toString(), value -> { throw new AssertionError(); }));
            Assertions.assertEquals(project.toRealPath().toString(), WebController.resolveChangeRoot(
                    null, project.toString(), null, workspace.toString(), value -> project.toString()));
            Assertions.assertThrows(IllegalArgumentException.class, () -> WebController.resolveChangeRoot(
                    null, arbitrary.toString(), null, workspace.toString(), value -> {
                        throw new IllegalArgumentException("not registered");
                    }));
        } finally {
            Files.deleteIfExists(arbitrary);
            Files.deleteIfExists(project);
            Files.deleteIfExists(workspace);
        }
    }
}
