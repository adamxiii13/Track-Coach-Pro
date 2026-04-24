/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Square, Timer, History, Trash2, Plus, User, ChevronDown, ChevronUp, X, Settings, Moon, Sun, Check, Download, ExternalLink, Loader2, Users, Share2, LogOut } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { db, auth } from './firebase';
import { 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot, 
  updateDoc, 
  collection, 
  addDoc, 
  query, 
  where, 
  serverTimestamp, 
  deleteDoc,
  writeBatch,
  getDocs
} from 'firebase/firestore';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged } from 'firebase/auth';

type ColorTheme = 'emerald' | 'blue' | 'red' | 'orange' | 'purple' | 'sky';

type StopwatchSize = 'xs' | 'small' | 'medium' | 'large';
type LayoutType = 'stack' | 'grid';
type RaceType = 'None' | '400m' | '800m' | '1600m' | '3200m';

interface ThemeSettings {
  isDark: boolean;
  color: ColorTheme;
  size: StopwatchSize;
  layout: LayoutType;
}

const THEME_COLORS: { name: string; value: ColorTheme; class: string }[] = [
  { name: 'Green', value: 'emerald', class: 'bg-emerald-500' },
  { name: 'Blue', value: 'blue', class: 'bg-blue-500' },
  { name: 'Red', value: 'red', class: 'bg-red-500' },
  { name: 'Orange', value: 'orange', class: 'bg-orange-500' },
  { name: 'Purple', value: 'purple', class: 'bg-purple-500' },
  { name: 'Light Blue', value: 'sky', class: 'bg-sky-500' },
];

interface LogEntry {
  type: 'Split' | 'Lap' | 'Finish';
  time: number; // For Split: time since last lap. For Lap: time since last lap.
  timeSinceLastSplit?: number; // For Split: time since last split
  cumulativeTime: number; // Total time at this point
  formatted: string;
  formattedSinceLastSplit?: string; // For Split
  formattedCumulative: string;
  number: number;
  pace?: string;
  prDelta?: number;
}

interface RosterAthlete {
  id: string;
  name: string;
  prs: Partial<Record<RaceType, number>>;
}

interface RunnerState {
  id: string;
  name: string;
  athleteId?: string;
  startTime: number | null;
  elapsedTime: number;
  isRunning: boolean;
  lastLapTime: number; // TimeOfLastLap
  lastSplitTime: number; // TimeOfLastSplit
  logs: LogEntry[];
  isExpanded: boolean;
}

const formatTime = (ms: number) => {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const milliseconds = Math.floor((ms % 1000) / 10);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(2, '0')}`;
};

const getTotalDistance = (logs: LogEntry[], race: RaceType) => {
  let total = 0;
  const splitIncrement = race === '400m' ? 100 : 200;
  const lapIncrement = 400;
  
  // logs are ordered [newest, ..., oldest]
  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i];
    const prevLog = logs[i + 1]; // The one that happened before this one
    if (log.type === 'Split') {
      total += splitIncrement;
    } else if (log.type === 'Lap' || log.type === 'Finish') {
      if (prevLog && prevLog.type === 'Split') {
        total += splitIncrement;
      } else {
        total += lapIncrement;
      }
    }
  }
  return total;
};

const calculateProjectedTime = (totalMs: number, distanceCovered: number, race: RaceType): string | undefined => {
  if (race === 'None' || distanceCovered === 0) return undefined;
  
  const raceDistances: Record<string, number> = {
    '400m': 400,
    '800m': 800,
    '1600m': 1600,
    '3200m': 3200
  };
  
  const targetDistance = raceDistances[race];
  if (!targetDistance) return undefined;
  
  const projectedMs = (totalMs / distanceCovered) * targetDistance;
  return formatTime(projectedMs);
};

const getTargetTimeForDistance = (athlete: RosterAthlete, race: RaceType, distance: number) => {
  const pr = athlete.prs[race];
  if (!pr) return null;
  
  const raceDistances: Record<RaceType, number> = {
    'None': 0,
    '400m': 400,
    '800m': 800,
    '1600m': 1600,
    '3200m': 3200
  };
  
  const totalDistance = raceDistances[race];
  if (totalDistance === 0) return null;
  
  return (pr / totalDistance) * distance;
};

export default function App() {
  const [runners, setRunners] = useState<RunnerState[]>([
    {
      id: crypto.randomUUID(),
      name: 'Runner 1',
      startTime: null,
      elapsedTime: 0,
      isRunning: false,
      lastLapTime: 0,
      logs: [],
      isExpanded: false,
    }
  ]);

  const [theme, setTheme] = useState<ThemeSettings>({
    isDark: true,
    color: 'emerald',
    size: 'large',
    layout: 'stack',
  });

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [exportModal, setExportModal] = useState<{ isOpen: boolean; runnerId?: string }>({ isOpen: false });
  const [exportData, setExportData] = useState({ raceName: '', meetName: '' });
  const [isExporting, setIsExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ url: string } | null>(null);
  const [authTokens, setAuthTokens] = useState<any>(null);
  // Multi-Coach State
  const [sessionPin, setSessionPin] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [sessionData, setSessionData] = useState<any>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [joinPin, setJoinPin] = useState('');
  const [firebaseUser, setFirebaseUser] = useState<any>(null);
  const [isMultiCoachModalOpen, setIsMultiCoachModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'stopwatch' | 'roster'>('stopwatch');
  const [roster, setRoster] = useState<RosterAthlete[]>([]);

  const [selectedRace, setSelectedRace] = useState<RaceType>('None');

  const triggerHaptic = (pattern: number | number[] = 50) => {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  };

  useEffect(() => {
    if (sessionData?.raceType && !isHost) {
      setSelectedRace(sessionData.raceType);
    }
  }, [sessionData?.raceType, isHost]);

  const handleRaceSelection = async (race: RaceType) => {
    setSelectedRace(race);
    if (sessionPin && isHost) {
      try {
        const sessionRef = doc(db, 'sessions', sessionPin);
        await updateDoc(sessionRef, { raceType: race });
      } catch (error) {
        console.error('Error updating race type in Firebase:', error);
      }
    }
  };

  const requestRef = useRef<number | null>(null);
  const sessionDataRef = useRef<any>(null);

  useEffect(() => {
    sessionDataRef.current = sessionData;
  }, [sessionData]);

  // Firebase Auth
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setFirebaseUser(user);
        // Load user's roster
        const rosterRef = collection(db, 'users', user.uid, 'roster');
        getDocs(rosterRef).then(snapshot => {
          const userRoster: RosterAthlete[] = [];
          snapshot.forEach(doc => {
            userRoster.push({ id: doc.id, ...doc.data() } as RosterAthlete);
          });
          if (userRoster.length > 0) {
            setRoster(userRoster);
          }
        });
      } else {
        setFirebaseUser(null);
      }
    });
    return () => unsubscribe();
  }, []);

  // Multi-Coach Session Listener
  useEffect(() => {
    if (!sessionPin) return;

    const sessionRef = doc(db, 'sessions', sessionPin);
    const unsubscribeSession = onSnapshot(sessionRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        setSessionData(data);
        
        // When session status changes to active, ensure all local runners start
        if (data.status === 'active' && data.startTime) {
          setRunners(prev => prev.map(r => {
            const hasFinished = r.logs.some(l => l.type === 'Finish');
            if (!r.isRunning && !hasFinished) {
              return {
                ...r,
                isRunning: true,
                startTime: data.startTime,
                lastLapTime: 0,
                lastSplitTime: 0,
              };
            }
            return r;
          }));
        } else if (data.status === 'waiting') {
          // If session is reset to waiting, reset local runners
          setRunners(prev => prev.map(r => ({
            ...r,
            startTime: null,
            elapsedTime: 0,
            isRunning: false,
            lastLapTime: 0,
            lastSplitTime: 0,
            logs: [],
          })));
        }
      } else {
        leaveSession();
      }
    });

    const runnersRef = collection(db, 'sessions', sessionPin, 'runners');
    const unsubscribeRunners = onSnapshot(runnersRef, (snapshot) => {
      const remoteRunners = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as any[];
      
      const currentSession = sessionDataRef.current;
      
      if (remoteRunners.length > 0) {
        setRunners(prev => {
          // If in a session, the remote runners are the source of truth for the list
          return remoteRunners.map(remote => {
            const existing = prev.find(r => r.id === remote.id);
            
            const hasFinished = remote.logs?.some((l: any) => l.type === 'Finish');
            
            // Determine running state based on session status and runner's finish status
            // This prevents stale runner updates from stopping a race that just started
            const isRunning = (currentSession?.status === 'active' && !hasFinished);
            const startTime = remote.startTime || (isRunning ? currentSession?.startTime : null);

            return {
              id: remote.id,
              name: remote.name,
              logs: remote.logs || [],
              isRunning: isRunning,
              startTime: startTime,
              elapsedTime: existing?.elapsedTime || 0,
              lastLapTime: remote.lastLapTime || 0,
              lastSplitTime: remote.lastSplitTime || 0,
              isExpanded: existing?.isExpanded || false
            };
          });
        });
      }
    });

    const rosterRef = collection(db, 'sessions', sessionPin, 'roster');
    const unsubscribeRoster = onSnapshot(rosterRef, (snapshot) => {
      const remoteRoster = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as RosterAthlete[];
      setRoster(remoteRoster);
    });

    return () => {
      unsubscribeSession();
      unsubscribeRunners();
      unsubscribeRoster();
    };
  }, [sessionPin]);

  // Periodic Session Sync (Heartbeat) - Every 10 seconds as requested
  useEffect(() => {
    if (!sessionPin) return;
    const interval = setInterval(async () => {
      try {
        // Refresh session data
        const sessionRef = doc(db, 'sessions', sessionPin);
        const sessionSnap = await getDoc(sessionRef);
        if (sessionSnap.exists()) {
          setSessionData(sessionSnap.data());
        }

        // Refresh runners list to ensure we haven't missed any updates
        const runnersRef = collection(db, 'sessions', sessionPin, 'runners');
        const runnersSnap = await getDocs(runnersRef);
        const remoteRunners = runnersSnap.docs.map(d => ({ id: d.id, ...d.data() })) as any[];
        
        if (remoteRunners.length > 0) {
          setRunners(prev => {
            return remoteRunners.map(remote => {
              const existing = prev.find(r => r.id === remote.id);
              const hasFinished = remote.logs?.some((l: any) => l.type === 'Finish');
              const isRunning = remote.isRunning !== undefined ? remote.isRunning : (sessionData?.status === 'active' && !hasFinished);
              const startTime = remote.startTime !== undefined ? remote.startTime : (isRunning ? sessionData?.startTime : null);

              return {
                id: remote.id,
                name: remote.name,
                athleteId: remote.athleteId,
                logs: remote.logs || [],
                isRunning: isRunning,
                startTime: startTime,
                elapsedTime: existing?.elapsedTime || 0,
                lastLapTime: remote.lastLapTime || 0,
                lastSplitTime: remote.lastSplitTime || 0,
                isExpanded: existing?.isExpanded || false
              };
            });
          });
        }

        // Refresh roster
        const rosterRef = collection(db, 'sessions', sessionPin, 'roster');
        const rosterSnap = await getDocs(rosterRef);
        const remoteRoster = rosterSnap.docs.map(d => ({ id: d.id, ...d.data() })) as RosterAthlete[];
        if (remoteRoster.length > 0) {
          setRoster(remoteRoster);
        }
      } catch (e) {
        console.error("Session heartbeat sync error:", e);
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [sessionPin, sessionData]);

  const signInWithGoogle = async () => {
    const provider = new GoogleAuthProvider();
    try {
      const result = await signInWithPopup(auth, provider);
      setFirebaseUser(result.user);
      return result.user;
    } catch (error) {
      console.error("Error signing in with Google", error);
      alert("Failed to sign in with Google. Please try again.");
      return null;
    }
  };

  const hostSession = async () => {
    let user = firebaseUser;
    if (!user) {
      user = await signInWithGoogle();
    }
    if (!user) return;

    try {
      const pin = Math.floor(1000 + Math.random() * 9000).toString();
      const sessionRef = doc(db, 'sessions', pin);
      
      await setDoc(sessionRef, {
        hostId: user.uid,
        status: 'waiting',
        startTime: null,
        raceType: selectedRace,
        createdAt: Date.now()
      });

      // Add current runners and roster to the session
      const batch = writeBatch(db);
      runners.forEach(runner => {
        const runnerRef = doc(db, 'sessions', pin, 'runners', runner.id);
        batch.set(runnerRef, {
          name: runner.name,
          logs: runner.logs
        });
      });

      roster.forEach(athlete => {
        const athleteRef = doc(db, 'sessions', pin, 'roster', athlete.id);
        batch.set(athleteRef, {
          name: athlete.name,
          prs: athlete.prs
        });
      });

      await batch.commit();

      setSessionPin(pin);
      setIsHost(true);
      setIsMultiCoachModalOpen(false);
    } catch (error) {
      console.error("Error hosting session:", error);
      alert("Failed to host session. Please check your connection.");
    }
  };

  const joinSession = async () => {
    if (!joinPin) return;
    let user = firebaseUser;
    if (!user) {
      user = await signInWithGoogle();
    }
    if (!user) return;

    try {
      const sessionRef = doc(db, 'sessions', joinPin);
      const snapshot = await getDoc(sessionRef);
      
      if (snapshot.exists()) {
        setSessionPin(joinPin);
        setIsHost(false);
        setIsMultiCoachModalOpen(false);
        setJoinPin('');
      } else {
        alert('Session not found. Please check the PIN.');
      }
    } catch (error) {
      console.error("Error joining session:", error);
      alert("Failed to join session. Please check your connection.");
    }
  };

  const leaveSession = () => {
    setSessionPin(null);
    setIsHost(false);
    setSessionData(null);
    
    // Reload user's roster if logged in, otherwise clear
    if (firebaseUser) {
      const rosterRef = collection(db, 'users', firebaseUser.uid, 'roster');
      getDocs(rosterRef).then(snapshot => {
        const userRoster: RosterAthlete[] = [];
        snapshot.forEach(doc => {
          userRoster.push({ id: doc.id, ...doc.data() } as RosterAthlete);
        });
        setRoster(userRoster);
      });
    } else {
      setRoster([]);
    }
  };

  // Load from localStorage on mount
  useEffect(() => {
    const savedRunners = localStorage.getItem('track_coach_runners');
    const savedTheme = localStorage.getItem('track_coach_theme');
    const savedRoster = localStorage.getItem('track_coach_roster');
    const savedSessionPin = localStorage.getItem('track_coach_session_pin');
    const savedIsHost = localStorage.getItem('track_coach_is_host');
    
    if (savedRunners) {
      try {
        const parsed = JSON.parse(savedRunners);
        // Don't reset isRunning/startTime anymore to allow persistence on refresh
        setRunners(parsed);
      } catch (e) {
        console.error('Failed to parse saved runners', e);
      }
    }

    if (savedSessionPin) {
      setSessionPin(savedSessionPin);
    }

    if (savedIsHost) {
      setIsHost(savedIsHost === 'true');
    }

    if (savedRoster) {
      try {
        setRoster(JSON.parse(savedRoster));
      } catch (e) {
        console.error('Failed to parse saved roster', e);
      }
    }
    
    if (savedTheme) {
      try {
        setTheme(JSON.parse(savedTheme));
      } catch (e) {
        console.error('Failed to parse saved theme', e);
      }
    }

    // Check if user is logged in
    // (Handled by Firebase onAuthStateChanged)
  }, []);

  // Save to localStorage on change
  useEffect(() => {
    localStorage.setItem('track_coach_runners', JSON.stringify(runners));
    localStorage.setItem('track_coach_theme', JSON.stringify(theme));
    localStorage.setItem('track_coach_roster', JSON.stringify(roster));
    if (sessionPin) {
      localStorage.setItem('track_coach_session_pin', sessionPin);
      localStorage.setItem('track_coach_is_host', String(isHost));
    } else {
      localStorage.removeItem('track_coach_session_pin');
      localStorage.removeItem('track_coach_is_host');
    }
  }, [runners, theme, roster, sessionPin, isHost]);

  // Sync with backend if logged in
  // (Handled by Firestore syncAthleteToFirebase)

  // Recalculate logs when race type or roster changes
  useEffect(() => {
    setRunners(prev => {
      let changed = false;
      const next = prev.map(runner => {
        if (runner.logs.length === 0) return runner;
        
        const reversedLogs = [...runner.logs].reverse();
        let currentDist = 0;
        const splitIncrement = selectedRace === '400m' ? 100 : 200;
        
        const newLogs = reversedLogs.map((log, index) => {
          const prevLog = reversedLogs[index - 1];
          let logDist = currentDist;
          if (log.type === 'Split') {
            logDist += splitIncrement;
          } else if (log.type === 'Lap' || log.type === 'Finish') {
            if (prevLog && prevLog.type === 'Split') {
              logDist += splitIncrement;
            } else {
              logDist += 400;
            }
          }
          currentDist = logDist;
          
          const pace = calculateProjectedTime(log.cumulativeTime, logDist, selectedRace);
          let prDelta: number | undefined = undefined;
          if (runner.athleteId) {
            const athlete = roster.find(a => a.id === runner.athleteId);
            if (athlete) {
              const target = getTargetTimeForDistance(athlete, selectedRace, logDist);
              if (target !== null) {
                prDelta = target - log.cumulativeTime;
              }
            }
          }
          
          if (log.pace !== pace || log.prDelta !== prDelta) {
            changed = true;
          }
          
          return { ...log, pace, prDelta };
        }).reverse();
        
        if (changed) {
          const updatedRunner = { ...runner, logs: newLogs };
          // If we are the host, sync the recalculated logs to Firebase
          if (sessionPin && isHost) {
            syncRunnerToFirebase(updatedRunner);
          }
          return updatedRunner;
        }
        return runner;
      });
      
      return changed ? next : prev;
    });
  }, [selectedRace, roster, sessionPin, isHost]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        if (event.data.tokens) {
          setAuthTokens(event.data.tokens);
        }
        // Retry export if it was waiting for auth
        if (exportModal.isOpen) {
          // Small delay to ensure state is updated
          setTimeout(() => {
            performExport(event.data.tokens);
          }, 500);
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [exportModal, exportData]);

  const syncRunnerToFirebase = async (runner: RunnerState) => {
    if (!sessionPin) return;
    try {
      const runnerRef = doc(db, 'sessions', sessionPin, 'runners', runner.id);
      
      // Sanitize logs to remove undefined fields (like pace)
      const sanitizedLogs = (runner.logs || []).map(log => {
        const sanitized: any = { ...log };
        Object.keys(sanitized).forEach(key => {
          if (sanitized[key] === undefined) {
            delete sanitized[key];
          }
        });
        return sanitized;
      });

      await setDoc(runnerRef, {
        name: runner.name,
        athleteId: runner.athleteId || null,
        logs: sanitizedLogs,
        isRunning: runner.isRunning,
        startTime: runner.startTime,
        lastLapTime: runner.lastLapTime || 0,
        lastSplitTime: runner.lastSplitTime || 0
      }, { merge: true });
    } catch (error) {
      console.error('Firebase sync error:', error);
    }
  };

  const syncAthleteToFirebase = async (athlete: RosterAthlete) => {
    if (sessionPin) {
      try {
        const athleteRef = doc(db, 'sessions', sessionPin, 'roster', athlete.id);
        await setDoc(athleteRef, {
          name: athlete.name,
          prs: athlete.prs
        });
      } catch (error) {
        console.error('Firebase session roster sync error:', error);
      }
    }

    if (firebaseUser) {
      try {
        const userAthleteRef = doc(db, 'users', firebaseUser.uid, 'roster', athlete.id);
        await setDoc(userAthleteRef, {
          name: athlete.name,
          prs: athlete.prs
        });
      } catch (error) {
        console.error('Firebase user roster sync error:', error);
      }
    }
  };

  const addAthlete = async (name: string) => {
    const newAthlete: RosterAthlete = {
      id: crypto.randomUUID(),
      name,
      prs: {}
    };
    setRoster(prev => [...prev, newAthlete]);
    if (sessionPin || firebaseUser) await syncAthleteToFirebase(newAthlete);
  };

  const updateAthletePR = async (athleteId: string, race: RaceType, timeMs: number) => {
    setRoster(prev => {
      const updated = prev.map(a => {
        if (a.id === athleteId) {
          const newPrs = { ...a.prs, [race]: timeMs };
          const updatedAthlete = { ...a, prs: newPrs };
          if (sessionPin || firebaseUser) syncAthleteToFirebase(updatedAthlete);
          return updatedAthlete;
        }
        return a;
      });
      return updated;
    });
  };

  const checkAndUpdatePR = (athleteId: string, race: RaceType, timeMs: number) => {
    if (race === 'None') return;
    setRoster(prev => {
      const athlete = prev.find(a => a.id === athleteId);
      if (!athlete) return prev;
      
      const currentPR = athlete.prs[race];
      // If no PR exists or the new time is faster, update it
      if (!currentPR || timeMs < currentPR) {
        const updated = prev.map(a => {
          if (a.id === athleteId) {
            const updatedAthlete = { ...a, prs: { ...a.prs, [race]: timeMs } };
            if (sessionPin || firebaseUser) syncAthleteToFirebase(updatedAthlete);
            return updatedAthlete;
          }
          return a;
        });
        return updated;
      }
      return prev;
    });
  };

  const removeAthlete = async (athleteId: string) => {
    setRoster(prev => prev.filter(a => a.id !== athleteId));
    if (sessionPin) {
      try {
        await deleteDoc(doc(db, 'sessions', sessionPin, 'roster', athleteId));
      } catch (error) {
        console.error('Error removing athlete from session:', error);
      }
    }
    if (firebaseUser) {
      try {
        await deleteDoc(doc(db, 'users', firebaseUser.uid, 'roster', athleteId));
      } catch (error) {
        console.error('Error removing athlete from user roster:', error);
      }
    }
  };

  const updateTimers = useCallback(() => {
    const now = Date.now();
    setRunners((prevRunners) =>
      prevRunners.map((runner) => {
        if (runner.isRunning && runner.startTime !== null) {
          // Fix negative numbers by ensuring elapsed is at least 0
          const elapsed = Math.max(0, now - runner.startTime);
          return {
            ...runner,
            elapsedTime: elapsed,
          };
        }
        return runner;
      })
    );
    requestRef.current = requestAnimationFrame(updateTimers);
  }, []);

  useEffect(() => {
    requestRef.current = requestAnimationFrame(updateTimers);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [updateTimers]);

  const startAll = async () => {
    triggerHaptic([40, 30, 40]);
    const now = Date.now();
    const uid = firebaseUser?.uid;
    if (!uid) return;

    const updatedRunners = runners.map((r) => {
      const hasFinished = r.logs.some(l => l.type === 'Finish');
      if (!r.isRunning && !hasFinished) {
        return {
          ...r,
          isRunning: true,
          startTime: now - r.elapsedTime,
          lastLapTime: r.elapsedTime,
          lastSplitTime: r.elapsedTime,
        };
      }
      return r;
    });
    setRunners(updatedRunners);

    // If in a session, update session status to active so it starts for everyone
    if (sessionPin) {
      try {
        const batch = writeBatch(db);
        const sessionRef = doc(db, 'sessions', sessionPin);
        batch.update(sessionRef, { 
          status: 'active', 
          startTime: now,
          starterId: uid
        });

        // Update all runners in the session to start them
        updatedRunners.forEach(r => {
          const runnerRef = doc(db, 'sessions', sessionPin, 'runners', r.id);
          batch.update(runnerRef, {
            isRunning: r.isRunning,
            startTime: r.startTime,
            lastLapTime: r.lastLapTime,
            lastSplitTime: r.lastSplitTime,
          });
        });

        await batch.commit();
      } catch (error) {
        console.error('Error starting session in Firebase:', error);
      }
    }
  };

  const stopAll = async () => {
    triggerHaptic(100);
    const uid = firebaseUser?.uid;
    if (sessionPin && sessionData?.starterId && sessionData.starterId !== uid) {
      alert("Only the coach who started the race can stop it.");
      return;
    }

    const updatedRunners = runners.map((r) => {
      if (r.isRunning) {
        const lastLap = r.lastLapTime ?? 0;
        const lapDuration = r.elapsedTime - lastLap;
        const lapCount = r.logs.filter(l => l.type === 'Lap' || l.type === 'Finish').length + 1;
        const lastLog = r.logs[0];
        const splitIncrement = selectedRace === '400m' ? 100 : 200;
        const increment = (lastLog && lastLog.type === 'Split') ? splitIncrement : 400;
        const currentDistance = getTotalDistance(r.logs, selectedRace) + increment;

        let prDelta: number | undefined = undefined;
        if (r.athleteId) {
          const athlete = roster.find(a => a.id === r.athleteId);
          if (athlete) {
            const targetCumulative = getTargetTimeForDistance(athlete, selectedRace, currentDistance);
            if (targetCumulative !== null) {
              prDelta = targetCumulative - r.elapsedTime;
            }
          }
        }

        const entry: LogEntry = {
          type: 'Finish',
          time: lapDuration,
          cumulativeTime: r.elapsedTime,
          formatted: formatTime(lapDuration),
          formattedCumulative: formatTime(r.elapsedTime),
          number: lapCount,
          pace: calculateProjectedTime(r.elapsedTime, currentDistance, selectedRace),
          prDelta: prDelta,
        };
        const updatedRunner = {
          ...r,
          isRunning: false,
          startTime: null,
          lastLapTime: r.elapsedTime,
          logs: [entry, ...r.logs],
          isExpanded: true,
        };
        return updatedRunner;
      }
      return r;
    });
    setRunners(updatedRunners);

    // If in a session, update session status to finished so it stops for everyone
    if (sessionPin) {
      try {
        const batch = writeBatch(db);
        const sessionRef = doc(db, 'sessions', sessionPin);
        batch.update(sessionRef, { status: 'finished' });

        // Update all runners in the session to stop them
        updatedRunners.forEach(r => {
          const runnerRef = doc(db, 'sessions', sessionPin, 'runners', r.id);
          batch.update(runnerRef, {
            isRunning: r.isRunning,
            logs: r.logs,
            lastLapTime: r.lastLapTime,
          });
        });

        await batch.commit();
      } catch (error) {
        console.error('Error stopping session in Firebase:', error);
      }
    }
  };

  const resetAll = async () => {
    const uid = firebaseUser?.uid;
    if (sessionPin && sessionData?.status === 'active' && sessionData?.starterId && sessionData.starterId !== uid) {
      alert("Only the coach who started the race can reset it.");
      return;
    }

    const resetRunners = runners.map((r, i) => ({
      ...r,
      startTime: null,
      elapsedTime: 0,
      isRunning: false,
      lastLapTime: 0,
      lastSplitTime: 0,
      logs: [],
    }));
    setRunners(resetRunners);

    if (sessionPin) {
      try {
        const sessionRef = doc(db, 'sessions', sessionPin);
        await updateDoc(sessionRef, { 
          status: 'waiting', 
          startTime: null,
          starterId: null
        });
        
        const runnersRef = collection(db, 'sessions', sessionPin, 'runners');
        const snapshot = await getDocs(runnersRef);
        const batch = writeBatch(db);
        snapshot.docs.forEach(doc => {
          batch.update(doc.ref, { 
            isRunning: false,
            startTime: null,
            logs: [],
            lastLapTime: 0,
            lastSplitTime: 0
          });
        });
        await batch.commit();
      } catch (error) {
        console.error('Error resetting session in Firebase:', error);
      }
    }
  };

  const resetRunner = async (id: string) => {
    setRunners((prev) =>
      prev.map((r) => {
        if (r.id === id) {
          const updated = {
            ...r,
            startTime: null,
            elapsedTime: 0,
            isRunning: false,
            lastLapTime: 0,
            lastSplitTime: 0,
            logs: [],
          };
          if (sessionPin) syncRunnerToFirebase(updated);
          return updated;
        }
        return r;
      })
    );
  };

  const addRunner = async () => {
    const isRaceActive = sessionPin && sessionData?.status === 'active';
    const startTime = isRaceActive ? sessionData.startTime : null;

    const newRunner: RunnerState = {
      id: crypto.randomUUID(),
      name: `Runner ${runners.length + 1}`,
      startTime: startTime,
      elapsedTime: 0,
      isRunning: !!isRaceActive,
      lastLapTime: 0,
      lastSplitTime: 0,
      logs: [],
      isExpanded: false,
    };

    setRunners((prev) => [...prev, newRunner]);

    if (sessionPin) {
      await syncRunnerToFirebase(newRunner);
    }
  };

  const removeRunner = async (id: string) => {
    setRunners((prev) => prev.filter((r) => r.id !== id));
    
    if (sessionPin) {
      try {
        const runnerRef = doc(db, 'sessions', sessionPin, 'runners', id);
        await deleteDoc(runnerRef);
      } catch (error) {
        console.error('Error removing runner from Firebase:', error);
      }
    }
  };

  const toggleRunner = (id: string) => {
    triggerHaptic(40);
    const now = Date.now();
    setRunners((prev) => {
      const next = prev.map((r) => {
        if (r.id === id) {
          if (r.isRunning) {
            const lastLap = r.lastLapTime ?? 0;
            const lapDuration = r.elapsedTime - lastLap;
            const lapCount = r.logs.filter(l => l.type === 'Lap' || l.type === 'Finish').length + 1;
            const lastLog = r.logs[0];
            const splitIncrement = selectedRace === '400m' ? 100 : 200;
            const increment = (lastLog && lastLog.type === 'Split') ? splitIncrement : 400;
            const currentDistance = getTotalDistance(r.logs, selectedRace) + increment;
            let prDelta: number | undefined = undefined;
            if (r.athleteId) {
              const athlete = roster.find(a => a.id === r.athleteId);
              if (athlete) {
                const targetCumulative = getTargetTimeForDistance(athlete, selectedRace, currentDistance);
                if (targetCumulative !== null) {
                  prDelta = targetCumulative - r.elapsedTime;
                }
              }
            }

            const entry: LogEntry = {
              type: 'Finish',
              time: lapDuration,
              cumulativeTime: r.elapsedTime,
              formatted: formatTime(lapDuration),
              formattedCumulative: formatTime(r.elapsedTime),
              number: lapCount,
              pace: calculateProjectedTime(r.elapsedTime, currentDistance, selectedRace),
              prDelta: prDelta,
            };
            const updatedRunner = { 
              ...r, 
              isRunning: false, 
              startTime: null,
              lastLapTime: r.elapsedTime,
              logs: [entry, ...r.logs],
              isExpanded: true
            };

            // Auto-update PR if linked to athlete
            if (r.athleteId && selectedRace !== 'None') {
              checkAndUpdatePR(r.athleteId, selectedRace, r.elapsedTime);
            }

            return updatedRunner;
          } else {
            const startTime = (sessionPin && sessionData?.status === 'active' && sessionData?.startTime) 
              ? sessionData.startTime 
              : now - r.elapsedTime;
            const updatedRunner = { 
              ...r, 
              isRunning: true, 
              startTime: startTime,
              lastLapTime: r.elapsedTime,
              lastSplitTime: r.elapsedTime,
            };
            return updatedRunner;
          }
        }
        return r;
      });

      // Sync the updated runner
      if (sessionPin) {
        const updated = next.find(r => r.id === id);
        if (updated) syncRunnerToFirebase(updated);
      }
      return next;
    });
  };

  const recordSplit = (id: string) => {
    triggerHaptic(60);
    setRunners((prev) => {
      const next = prev.map((r) => {
        if (r.id === id) {
          const lastSplit = r.lastSplitTime ?? 0;
          const lastLap = r.lastLapTime ?? 0;
          const timeSinceLastSplit = r.elapsedTime - lastSplit;
          const timeSinceLastLap = r.elapsedTime - lastLap;
          
          const lastLog = r.logs[0];
          const isDoubleSplit = lastLog && lastLog.type === 'Split' && (r.elapsedTime - lastLog.cumulativeTime < 2000) && selectedRace !== '400m';
          
          // Detect if user skipped the Lap (400m) mark and went straight from 200m split to 600m split (common if coach is only at 200m mark)
          const isMissedLap = lastLog && lastLog.type === 'Split' && !isDoubleSplit && selectedRace !== '400m' && selectedRace !== 'None';
          
          const splitIncrement = selectedRace === '400m' ? 100 : 200;
          
          if (isMissedLap) {
            // We missed the 400m Lap. Insert an estimated Lap at the midpoint.
            const midTime = (lastLog.cumulativeTime + r.elapsedTime) / 2;
            const distAtMid = getTotalDistance(r.logs, selectedRace) + splitIncrement;
            const distAtFinal = distAtMid + splitIncrement;
            
            let lapPrDelta: number | undefined = undefined;
            let splitPrDelta: number | undefined = undefined;
            
            if (r.athleteId) {
              const athlete = roster.find(a => a.id === r.athleteId);
              if (athlete) {
                const targetLap = getTargetTimeForDistance(athlete, selectedRace, distAtMid);
                const targetSplit = getTargetTimeForDistance(athlete, selectedRace, distAtFinal);
                if (targetLap !== null) lapPrDelta = targetLap - midTime;
                if (targetSplit !== null) splitPrDelta = targetSplit - r.elapsedTime;
              }
            }

            const lapEntry: LogEntry = {
              type: 'Lap',
              time: midTime - lastLog.cumulativeTime,
              cumulativeTime: midTime,
              formatted: formatTime(midTime - lastLog.cumulativeTime),
              formattedCumulative: formatTime(midTime),
              number: r.logs.filter(l => l.type === 'Lap' || l.type === 'Finish').length + 1,
              pace: calculateProjectedTime(midTime, distAtMid, selectedRace),
              prDelta: lapPrDelta
            };

            const splitEntry: LogEntry = {
              type: 'Split',
              time: r.elapsedTime - midTime,
              timeSinceLastSplit: r.elapsedTime - lastLog.cumulativeTime,
              cumulativeTime: r.elapsedTime,
              formatted: formatTime(r.elapsedTime - midTime),
              formattedSinceLastSplit: formatTime(r.elapsedTime - lastLog.cumulativeTime),
              formattedCumulative: formatTime(r.elapsedTime),
              number: r.logs.filter(l => l.type === 'Split').length + 1,
              pace: calculateProjectedTime(r.elapsedTime, distAtFinal, selectedRace),
              prDelta: splitPrDelta
            };

            return {
              ...r,
              lastSplitTime: r.elapsedTime,
              lastLapTime: r.elapsedTime,
              logs: [splitEntry, lapEntry, ...r.logs],
              isExpanded: true
            };
          }

          const effectiveLogs = isDoubleSplit ? r.logs.slice(1) : r.logs;
          const distanceIncrement = isDoubleSplit ? splitIncrement * 2 : splitIncrement;
          const currentDistance = getTotalDistance(effectiveLogs, selectedRace) + distanceIncrement;
          const splitCount = (isDoubleSplit ? r.logs.filter(l => l.type === 'Split').length : r.logs.filter(l => l.type === 'Split').length + 1);
          
          let prDelta: number | undefined = undefined;
          if (r.athleteId) {
            const athlete = roster.find(a => a.id === r.athleteId);
            if (athlete) {
              const targetCumulative = getTargetTimeForDistance(athlete, selectedRace, currentDistance);
              if (targetCumulative !== null) {
                prDelta = targetCumulative - r.elapsedTime;
              }
            }
          }

          const entry: LogEntry = {
            type: (selectedRace === '400m' && splitCount === 4) ? 'Finish' : isDoubleSplit ? 'Lap' : 'Split',
            time: timeSinceLastLap, // Main time is now time since last lap
            timeSinceLastSplit: isDoubleSplit ? timeSinceLastLap : timeSinceLastSplit,
            cumulativeTime: r.elapsedTime,
            formatted: formatTime(timeSinceLastLap),
            formattedSinceLastSplit: formatTime(isDoubleSplit ? timeSinceLastLap : timeSinceLastSplit),
            formattedCumulative: formatTime(r.elapsedTime),
            number: isDoubleSplit ? r.logs.filter(l => l.type === 'Lap' || l.type === 'Finish').length + 1 : splitCount,
            pace: calculateProjectedTime(r.elapsedTime, currentDistance, selectedRace),
            prDelta: prDelta,
          };

          const isFinishing = (selectedRace === '400m' && splitCount === 4) || (selectedRace === '800m' && currentDistance >= 800 && isDoubleSplit); 
          // Note: added a small check for 800m double-split finish if applicable, though recordLap handles it better

          const updatedRunner = { 
            ...r, 
            isRunning: isFinishing ? false : r.isRunning,
            startTime: isFinishing ? null : r.startTime,
            lastSplitTime: r.elapsedTime,
            lastLapTime: (isFinishing || selectedRace === '400m' || isDoubleSplit) ? r.elapsedTime : r.lastLapTime,
            logs: isDoubleSplit ? [entry, ...r.logs.slice(1)] : [entry, ...r.logs], 
            isExpanded: true 
          };

          // Auto-update PR if finishing and linked to athlete
          if (isFinishing && r.athleteId && selectedRace !== 'None') {
            checkAndUpdatePR(r.athleteId, selectedRace, r.elapsedTime);
          }

          return updatedRunner;
        }
        return r;
      });

      // Sync the updated runner
      if (sessionPin) {
        const updated = next.find(r => r.id === id);
        if (updated) syncRunnerToFirebase(updated);
      }
      return next;
    });
  };

  const recordLap = (id: string) => {
    triggerHaptic(80);
    setRunners((prev) => {
      const next = prev.map((r) => {
        if (r.id === id) {
          const lastLap = r.lastLapTime ?? 0;
          const lapDuration = r.elapsedTime - lastLap;
          const lapCount = r.logs.filter(l => l.type === 'Lap' || l.type === 'Finish').length + 1;
          const lastLog = r.logs[0];
          const splitIncrement = selectedRace === '400m' ? 100 : 200;
          const increment = (lastLog && lastLog.type === 'Split') ? splitIncrement : 400;
          const currentDistance = getTotalDistance(r.logs, selectedRace) + increment;

          let prDelta: number | undefined = undefined;
          if (r.athleteId) {
            const athlete = roster.find(a => a.id === r.athleteId);
            if (athlete) {
              const targetCumulative = getTargetTimeForDistance(athlete, selectedRace, currentDistance);
              if (targetCumulative !== null) {
                prDelta = targetCumulative - r.elapsedTime;
              }
            }
          }

          const entry: LogEntry = {
            type: 'Lap',
            time: lapDuration,
            cumulativeTime: r.elapsedTime,
            formatted: formatTime(lapDuration),
            formattedCumulative: formatTime(r.elapsedTime),
            number: lapCount,
            pace: calculateProjectedTime(r.elapsedTime, currentDistance, selectedRace),
            prDelta: prDelta,
          };
          const updatedRunner = {
            ...r,
            lastLapTime: r.elapsedTime,
            logs: [entry, ...r.logs],
            isExpanded: true,
          };
          return updatedRunner;
        }
        return r;
      });

      // Sync the updated runner
      if (sessionPin) {
        const updated = next.find(r => r.id === id);
        if (updated) syncRunnerToFirebase(updated);
      }
      return next;
    });
  };

  const removeLogEntry = (runnerId: string, logIndex: number) => {
    // If in a session, only the host or the starter should be able to delete logs
    const uid = firebaseUser?.uid;
    if (sessionPin && !isHost && sessionData?.starterId !== uid) {
      alert("Only the host or the coach who started the race can delete log entries.");
      return;
    }
    
    triggerHaptic(100);
    setRunners((prev) => {
      const next = prev.map((r) => {
        if (r.id === runnerId) {
          const newLogs = [...r.logs];
          newLogs.splice(logIndex, 1);
          
          const updated = { ...r, logs: newLogs };
          
          // If we removed the most recent log, adjust last times to the new most recent log
          if (logIndex === 0) {
            const nextLog = newLogs[0];
            if (nextLog) {
              updated.lastLapTime = nextLog.cumulativeTime;
              updated.lastSplitTime = nextLog.cumulativeTime;
            } else {
              updated.lastLapTime = 0;
              updated.lastSplitTime = 0;
            }
          }
          
          if (sessionPin) syncRunnerToFirebase(updated);
          return updated;
        }
        return r;
      });
      return next;
    });
  };

  const updateName = (id: string, name: string) => {
    setRunners((prev) => {
      const updated = prev.map((r) => (r.id === id ? { ...r, name, athleteId: undefined } : r));
      const runner = updated.find(r => r.id === id);
      if (runner && sessionPin) {
        syncRunnerToFirebase(runner);
      }
      return updated;
    });
  };

  const linkAthlete = (runnerId: string, athleteId: string) => {
    const athlete = roster.find(a => a.id === athleteId);
    if (!athlete) return;

    setRunners((prev) => {
      const updated = prev.map((r) => (r.id === runnerId ? { ...r, name: athlete.name, athleteId: athlete.id } : r));
      const runner = updated.find(r => r.id === runnerId);
      if (runner && sessionPin) {
        syncRunnerToFirebase(runner);
      }
      return updated;
    });
  };

  const toggleExpand = (id: string) => {
    setRunners((prev) => prev.map((r) => (r.id === id ? { ...r, isExpanded: !r.isExpanded } : r)));
  };

  const handleLogout = async () => {
    await auth.signOut();
  };

  const initiateExport = (runnerId?: string) => {
    setExportModal({ isOpen: true, runnerId });
    setExportResult(null);
    setExportData(prev => ({ 
      ...prev, 
      raceName: selectedRace === 'None' ? '' : selectedRace 
    }));
  };

  const performExport = async (overrideTokens?: any) => {
    if (!exportData.raceName) return;
    setIsExporting(true);

    const runnersToExport = exportModal.runnerId 
      ? runners.filter(r => r.id === exportModal.runnerId)
      : runners;

    const payload = {
      raceName: exportData.raceName,
      meetName: exportData.meetName,
      tokens: overrideTokens || authTokens,
      runners: runnersToExport.map(r => ({
        name: r.name,
        totalTime: formatTime(r.elapsedTime),
        logs: r.logs
      }))
    };

    try {
      const response = await fetch('/api/export/sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.status === 401) {
        // Need to authenticate
        const authRes = await fetch('/api/auth/google/url');
        const authData = await authRes.json();
        
        if (!authRes.ok) {
          throw new Error(authData.error || 'Failed to get authentication URL');
        }

        if (authData.url) {
          window.open(authData.url, 'google_auth', 'width=600,height=700');
        } else {
          throw new Error('No authentication URL received from server');
        }
        
        setIsExporting(false);
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Export failed');
      }
      
      const result = await response.json();
      setExportResult(result);
    } catch (error: any) {
      console.error('Export error:', error);
      alert(error.message || 'Failed to export to Google Sheets. Please check your connection and try again.');
    } finally {
      setIsExporting(false);
    }
  };

  const getColorClass = (type: 'text' | 'text400' | 'bg600' | 'bg500' | 'bg500_10' | 'border500_20' | 'shadow900_20' | 'hoverBg500' | 'hoverText500' | 'hoverBorder500_50' | 'hoverBg500_5' | 'border500' | 'ring500') => {
    const color = theme.color;
    const classes: Record<ColorTheme, Record<string, string>> = {
      emerald: {
        text: 'text-emerald-500',
        text400: 'text-emerald-400',
        bg600: 'bg-emerald-600',
        bg500: 'bg-emerald-500',
        bg500_10: 'bg-emerald-500/10',
        border500_20: 'border-emerald-500/20',
        shadow900_20: 'shadow-emerald-900/20',
        hoverBg500: 'hover:bg-emerald-500',
        hoverText500: 'hover:text-emerald-500',
        hoverBorder500_50: 'hover:border-emerald-500/50',
        hoverBg500_5: 'hover:bg-emerald-500/5',
        border500: 'border-emerald-500',
        ring500: 'focus:ring-emerald-500',
      },
      blue: {
        text: 'text-blue-500',
        text400: 'text-blue-400',
        bg600: 'bg-blue-600',
        bg500: 'bg-blue-500',
        bg500_10: 'bg-blue-500/10',
        border500_20: 'border-blue-500/20',
        shadow900_20: 'shadow-blue-900/20',
        hoverBg500: 'hover:bg-blue-500',
        hoverText500: 'hover:text-blue-500',
        hoverBorder500_50: 'hover:border-blue-500/50',
        hoverBg500_5: 'hover:bg-blue-500/5',
        border500: 'border-blue-500',
        ring500: 'focus:ring-blue-500',
      },
      red: {
        text: 'text-red-500',
        text400: 'text-red-400',
        bg600: 'bg-red-600',
        bg500: 'bg-red-500',
        bg500_10: 'bg-red-500/10',
        border500_20: 'border-red-500/20',
        shadow900_20: 'shadow-red-900/20',
        hoverBg500: 'hover:bg-red-500',
        hoverText500: 'hover:text-red-500',
        hoverBorder500_50: 'hover:border-red-500/50',
        hoverBg500_5: 'hover:bg-red-500/5',
        border500: 'border-red-500',
        ring500: 'focus:ring-red-500',
      },
      orange: {
        text: 'text-orange-500',
        text400: 'text-orange-400',
        bg600: 'bg-orange-600',
        bg500: 'bg-orange-500',
        bg500_10: 'bg-orange-500/10',
        border500_20: 'border-orange-500/20',
        shadow900_20: 'shadow-orange-900/20',
        hoverBg500: 'hover:bg-orange-500',
        hoverText500: 'hover:text-orange-500',
        hoverBorder500_50: 'hover:border-orange-500/50',
        hoverBg500_5: 'hover:bg-orange-500/5',
        border500: 'border-orange-500',
        ring500: 'focus:ring-orange-500',
      },
      purple: {
        text: 'text-purple-500',
        text400: 'text-purple-400',
        bg600: 'bg-purple-600',
        bg500: 'bg-purple-500',
        bg500_10: 'bg-purple-500/10',
        border500_20: 'border-purple-500/20',
        shadow900_20: 'shadow-purple-900/20',
        hoverBg500: 'hover:bg-purple-500',
        hoverText500: 'hover:text-purple-500',
        hoverBorder500_50: 'hover:border-purple-500/50',
        hoverBg500_5: 'hover:bg-purple-500/5',
        border500: 'border-purple-500',
        ring500: 'focus:ring-purple-500',
      },
      sky: {
        text: 'text-sky-500',
        text400: 'text-sky-400',
        bg600: 'bg-sky-600',
        bg500: 'bg-sky-500',
        bg500_10: 'bg-sky-500/10',
        border500_20: 'border-sky-500/20',
        shadow900_20: 'shadow-sky-900/20',
        hoverBg500: 'hover:bg-sky-500',
        hoverText500: 'hover:text-sky-500',
        hoverBorder500_50: 'hover:border-sky-500/50',
        hoverBg500_5: 'hover:bg-sky-500/5',
        border500: 'border-sky-500',
        ring500: 'focus:ring-sky-500',
      },
    };
    return classes[color][type];
  };

  const getBgClass = () => (theme.isDark ? 'bg-zinc-950' : 'bg-zinc-50');
  const getCardBgClass = () => (theme.isDark ? 'bg-zinc-900' : 'bg-white');
  const getTextColorClass = () => (theme.isDark ? 'text-zinc-100' : 'text-zinc-900');
  const getMutedTextColorClass = () => (theme.isDark ? 'text-zinc-500' : 'text-zinc-400');
  const getBorderColorClass = () => (theme.isDark ? 'border-zinc-800' : 'border-zinc-200');

  const getMaxWidthClass = () => {
    if (theme.layout === 'grid') {
      switch (theme.size) {
        case 'xs': return 'max-w-3xl';
        case 'small': return 'max-w-4xl';
        case 'medium': return 'max-w-5xl';
        case 'large': return 'max-w-7xl';
        default: return 'max-w-7xl';
      }
    }
    switch (theme.size) {
      case 'xs': return 'max-w-xs';
      case 'small': return 'max-w-md';
      case 'medium': return 'max-w-2xl';
      case 'large': return 'max-w-4xl';
      default: return 'max-w-4xl';
    }
  };

  const getGridColsClass = () => {
    if (theme.layout !== 'grid') return '';
    switch (theme.size) {
      case 'xs': return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5';
      case 'small': return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4';
      case 'medium': return 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3';
      case 'large': return 'grid-cols-1 sm:grid-cols-2';
      default: return 'grid-cols-1 sm:grid-cols-2';
    }
  };

  return (
    <div className={`min-h-screen ${getBgClass()} ${getTextColorClass()} font-sans transition-colors duration-300`}>
      {/* Header */}
      <header className={`sticky top-0 z-50 ${theme.isDark ? 'bg-zinc-900/80' : 'bg-white/80'} backdrop-blur-md border-b ${getBorderColorClass()} px-4 py-4 shadow-xl`}>
        <div className={`${theme.layout === 'grid' ? getMaxWidthClass() : 'max-w-2xl'} mx-auto`}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex flex-col gap-1">
              <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
                <Timer className={getColorClass('text')} />
                TRACK COACH <span className={`${getMutedTextColorClass()} font-light italic`}>PRO</span>
              </h1>
              <div className="flex items-center gap-4 mt-2">
                <button
                  onClick={() => setActiveTab('stopwatch')}
                  className={`text-[10px] font-bold transition-all flex items-center gap-1.5 ${activeTab === 'stopwatch' ? `${getColorClass('text')} border-b-2 ${getColorClass('border500')} pb-1` : `${getMutedTextColorClass()} hover:text-zinc-300 pb-1`}`}
                >
                  <Timer size={12} />
                  STOPWATCH
                </button>
                <button
                  onClick={() => setActiveTab('roster')}
                  className={`text-[10px] font-bold transition-all flex items-center gap-1.5 relative ${activeTab === 'roster' ? `${getColorClass('text')} border-b-2 ${getColorClass('border500')} pb-1` : `${getMutedTextColorClass()} hover:text-zinc-300 pb-1`}`}
                >
                  <Users size={12} />
                  ROSTER
                  {roster.length === 0 && (
                    <span className="absolute -top-1 -right-4 flex h-2 w-2">
                      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${getColorClass('bg500')} opacity-75`}></span>
                      <span className={`relative inline-flex rounded-full h-2 w-2 ${getColorClass('bg500')}`}></span>
                    </span>
                  )}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsMultiCoachModalOpen(true)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border ${sessionPin ? getColorClass('border500') : getBorderColorClass()} ${getCardBgClass()} ${sessionPin ? getColorClass('text') : getTextColorClass()} text-[10px] font-bold hover:bg-zinc-800 transition-all`}
              >
                <Users size={12} />
                {sessionPin ? `PIN: ${sessionPin}` : 'Multi-Coach'}
              </button>
              {firebaseUser ? (
                <div className="flex items-center gap-3">
                  {isSyncing && (
                    <motion.div 
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-500 uppercase tracking-widest"
                    >
                      <Loader2 size={10} className="animate-spin" />
                      Syncing
                    </motion.div>
                  )}
                  <button
                    onClick={() => auth.signOut()}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border ${getBorderColorClass()} ${getCardBgClass()} ${getTextColorClass()} text-[10px] font-bold hover:bg-zinc-800 transition-all`}
                  >
                    <User size={12} />
                    {firebaseUser.displayName || 'Coach'}
                  </button>
                </div>
              ) : (
                <button
                  onClick={signInWithGoogle}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border ${getBorderColorClass()} ${getCardBgClass()} ${getTextColorClass()} text-[10px] font-bold hover:bg-zinc-800 transition-all`}
                >
                  <User size={12} />
                  Sign in with Google
                </button>
              )}
              <button
                onClick={() => setIsSettingsOpen(true)}
                className={`p-2 ${getMutedTextColorClass()} ${getColorClass('hoverText500')} transition-colors`}
              >
                <Settings size={20} />
              </button>
              {sessionPin && sessionData?.status === 'active' && (
                <div className={`mt-2 text-[8px] ${getMutedTextColorClass()} flex items-center gap-1`}>
                  <div className={`w-1 h-1 rounded-full ${getColorClass('bg500')} animate-pulse`} />
                  Race started by {sessionData.starterId === firebaseUser?.uid ? 'you' : 'another coach'}
                </div>
              )}
            </div>
          </div>
          
          <div className="grid grid-cols-4 gap-2">
            <button
              onClick={startAll}
              disabled={sessionPin && sessionData?.status === 'active'}
              className={`flex items-center justify-center gap-2 ${getColorClass('bg600')} ${getColorClass('hoverBg500')} active:scale-95 text-white font-bold py-4 rounded-2xl transition-all shadow-lg ${getColorClass('shadow900_20')} text-xs disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <Play fill="currentColor" size={14} />
              START
            </button>
            <button
              onClick={stopAll}
              disabled={sessionPin && sessionData?.status === 'active' && sessionData?.starterId !== firebaseUser?.uid}
              className={`flex items-center justify-center gap-2 ${theme.isDark ? 'bg-zinc-800 hover:bg-zinc-700' : 'bg-zinc-200 hover:bg-zinc-300'} active:scale-95 ${theme.isDark ? 'text-white' : 'text-zinc-900'} font-bold py-4 rounded-2xl transition-all border ${getBorderColorClass()} text-xs disabled:opacity-30 disabled:cursor-not-allowed`}
            >
              <Square fill="currentColor" size={12} />
              STOP
            </button>
            <button
              onClick={resetAll}
              disabled={sessionPin && sessionData?.status === 'active' && sessionData?.starterId !== firebaseUser?.uid}
              className={`flex items-center justify-center gap-2 ${theme.isDark ? 'bg-zinc-800 hover:bg-zinc-700' : 'bg-zinc-200 hover:bg-zinc-300'} active:scale-95 ${theme.isDark ? 'text-white' : 'text-zinc-900'} font-bold py-4 rounded-2xl transition-all border ${getBorderColorClass()} text-xs disabled:opacity-30 disabled:cursor-not-allowed`}
            >
              <Trash2 size={14} />
              RESET
            </button>
            <button
              onClick={() => initiateExport()}
              className={`flex items-center justify-center gap-2 ${theme.isDark ? 'bg-zinc-800 hover:bg-zinc-700' : 'bg-zinc-200 hover:bg-zinc-300'} active:scale-95 ${theme.isDark ? 'text-white' : 'text-zinc-900'} font-bold py-4 rounded-2xl transition-all border ${getBorderColorClass()} text-xs`}
            >
              <Download size={14} />
              EXPORT
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      {activeTab === 'stopwatch' ? (
        <main className={`${getMaxWidthClass()} mx-auto p-4 pb-24 ${theme.layout === 'grid' ? `grid ${getGridColsClass()} gap-4 space-y-0` : 'space-y-4'}`}>
          {runners.map((runner, index) => (
          <motion.div
            key={runner.id}
            layout
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05 }}
            className={`${getCardBgClass()} rounded-3xl border ${getBorderColorClass()} overflow-hidden shadow-lg ${
              theme.layout === 'grid' ? `flex flex-col ${!runner.isExpanded ? 'aspect-square' : 'min-h-[280px]'}` : ''
            }`}
          >
            <div className={`${theme.size === 'xs' ? 'p-2' : theme.size === 'small' ? 'p-3' : 'p-4'} ${theme.layout === 'grid' ? 'flex-1 flex flex-col' : ''}`}>
              {/* Runner Info */}
              <div className={`flex items-center justify-between ${theme.size === 'xs' ? 'mb-1' : 'mb-3'}`}>
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div className={`${theme.size === 'xs' ? 'w-5 h-5 text-[8px]' : 'w-8 h-8 text-xs'} rounded-full ${theme.isDark ? 'bg-zinc-800' : 'bg-zinc-100'} flex items-center justify-center font-bold ${getMutedTextColorClass()} shrink-0`}>
                    {index + 1}
                  </div>
                  <div className="flex flex-col flex-1 min-w-0">
                    <div className="flex items-center gap-1 w-full overflow-hidden">
                      <input
                        type="text"
                        value={runner.name}
                        onChange={(e) => updateName(runner.id, e.target.value)}
                        disabled={sessionPin ? !isHost : false}
                        className={`bg-transparent border-none focus:ring-0 ${
                          theme.size === 'xs' ? 'text-xs' : theme.size === 'small' ? 'text-sm' : theme.size === 'medium' ? 'text-base' : 'text-lg'
                        } font-semibold ${getTextColorClass()} flex-1 min-w-0 p-0 placeholder:text-zinc-700 disabled:opacity-100 truncate`}
                        placeholder="Runner"
                      />
                      {runner.athleteId && selectedRace !== 'None' && (() => {
                        const athlete = roster.find(a => a.id === runner.athleteId);
                        const prTime = athlete?.prs[selectedRace];
                        if (prTime) {
                          return (
                            <span className={`text-[9px] font-bold ${getMutedTextColorClass()} whitespace-nowrap shrink-0`}>
                              ({formatTime(prTime)})
                            </span>
                          );
                        }
                        return null;
                      })()}
                    </div>
                    {roster.length > 0 && (
                      <select
                        value={runner.athleteId || ''}
                        onChange={(e) => linkAthlete(runner.id, e.target.value)}
                        className={`bg-transparent border-none focus:ring-0 p-0 text-[8px] font-bold uppercase tracking-widest ${getColorClass('text')} cursor-pointer opacity-60 hover:opacity-100 transition-opacity`}
                      >
                        <option value="" className={theme.isDark ? 'bg-zinc-900' : 'bg-white'}>Select Athlete</option>
                        {roster.map(a => (
                          <option key={a.id} value={a.id} className={theme.isDark ? 'bg-zinc-900' : 'bg-white'}>
                            {a.name} {selectedRace !== 'None' && a.prs[selectedRace] ? `(${formatTime(a.prs[selectedRace]!)})` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 shrink-0 ml-1">
                  <button
                    onClick={() => initiateExport(runner.id)}
                    className={`p-1.5 ${getMutedTextColorClass()} ${getColorClass('hoverText500')} transition-colors rounded-lg hover:bg-zinc-500/10`}
                    title="Export Runner"
                  >
                    <Download size={theme.size === 'xs' ? 12 : theme.size === 'small' ? 14 : 18} />
                  </button>
                  {(!sessionPin || isHost) && (
                    <button
                      onClick={() => removeRunner(runner.id)}
                      className={`p-1.5 ${getMutedTextColorClass()} hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors`}
                      title="Remove Runner"
                    >
                      <X size={theme.size === 'xs' ? 16 : theme.size === 'small' ? 18 : 22} />
                    </button>
                  )}
                </div>
              </div>

              {/* Timer Display */}
              <div className={`text-center ${theme.layout === 'grid' ? 'flex-1 flex flex-col justify-center py-1' : theme.size === 'xs' ? 'py-1' : theme.size === 'small' ? 'py-2' : theme.size === 'medium' ? 'py-4' : 'py-6'} ${theme.size === 'xs' ? 'mb-1' : 'mb-4'}`}>
                <div className={`${
                  theme.size === 'xs' ? 'text-xl' : theme.size === 'small' ? 'text-3xl' : theme.size === 'medium' ? 'text-5xl' : 'text-6xl'
                } font-mono font-black tracking-tighter tabular-nums ${getColorClass('text400')} drop-shadow-[0_0_20px_rgba(52,211,153,0.3)]`}>
                  {formatTime(runner.elapsedTime)}
                </div>

                {runner.isRunning && (
                  <div className={`${
                    theme.size === 'xs' ? 'text-[10px]' : theme.size === 'small' ? 'text-xs' : 'text-sm'
                  } font-mono font-bold tabular-nums ${getMutedTextColorClass()} mt-1 flex flex-col items-center gap-1`}>
                    <div>LAP: {formatTime(runner.elapsedTime - runner.lastLapTime)}</div>
                    {runner.athleteId && selectedRace !== 'None' && (
                      <div className="flex items-center gap-2">
                        {(() => {
                          const athlete = roster.find(a => a.id === runner.athleteId);
                          if (!athlete) return null;
                          const currentDist = getTotalDistance(runner.logs, selectedRace) + (selectedRace === '400m' ? 100 : 400); // Rough estimate for live delta
                          const target = getTargetTimeForDistance(athlete, selectedRace, currentDist);
                          if (target === null) return null;
                          const delta = target - runner.elapsedTime;
                          return (
                            <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${delta >= 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'}`}>
                              LIVE PACE: {delta >= 0 ? '+' : ''}{(delta / 1000).toFixed(1)}s
                            </span>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                )}
                
                {runner.logs.length > 0 && theme.size !== 'small' && theme.size !== 'xs' && (
                  <motion.div 
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    key={runner.logs[0].time}
                    className={`flex flex-col items-center mt-4 ${theme.size === 'medium' ? 'p-2' : 'p-3'} rounded-2xl bg-zinc-500/5 border border-zinc-500/10`}
                  >
                    <span className={`text-[10px] font-black uppercase tracking-[0.3em] ${
                      runner.logs[0].type === 'Split' ? 'text-blue-500' : 'text-purple-500'
                    } mb-1`}>
                      LAST {runner.logs[0].type}
                    </span>
                    <span className={`${theme.size === 'medium' ? 'text-2xl' : 'text-4xl'} font-mono font-black tabular-nums tracking-tighter ${getTextColorClass()}`}>
                      {runner.logs[0].formatted}
                    </span>
                    {runner.logs[0].pace && (
                      <span className={`${theme.size === 'medium' ? 'text-lg' : 'text-2xl'} text-orange-500 font-black tracking-tight mt-1`}>
                        PROJ: {runner.logs[0].pace}
                      </span>
                    )}
                  </motion.div>
                )}
              </div>

              {/* Controls */}
              <div className={`grid grid-cols-4 gap-1.5 ${theme.layout === 'grid' ? 'mt-auto' : ''}`}>
                <button
                  onClick={() => toggleRunner(runner.id)}
                  className={`flex flex-col items-center justify-center gap-0.5 ${theme.size === 'xs' ? 'py-1 rounded-xl' : theme.size === 'small' ? 'py-2 rounded-2xl' : 'py-3 rounded-2xl'} transition-all active:scale-95 ${
                    runner.isRunning
                      ? 'bg-red-500/10 text-red-500 border border-red-500/20'
                      : `${getColorClass('bg500_10')} ${getColorClass('text')} border ${getColorClass('border500_20')}`
                  }`}
                >
                  {runner.isRunning ? <Square size={theme.size === 'xs' ? 10 : theme.size === 'small' ? 14 : 18} fill="currentColor" /> : <Play size={theme.size === 'xs' ? 10 : theme.size === 'small' ? 14 : 18} fill="currentColor" />}
                  <span className={`${theme.size === 'xs' ? 'text-[7px]' : 'text-[9px]'} font-bold uppercase tracking-widest`}>
                    {runner.isRunning ? 'Stop' : 'Start'}
                  </span>
                </button>

                <button
                  onClick={() => recordSplit(runner.id)}
                  disabled={runner.elapsedTime === 0}
                  className={`flex flex-col items-center justify-center gap-0.5 ${theme.size === 'xs' ? 'py-1 rounded-xl' : theme.size === 'small' ? 'py-2 rounded-2xl' : 'py-3 rounded-2xl'} ${theme.isDark ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-zinc-700' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700 border-zinc-200'} border disabled:opacity-30 disabled:pointer-events-none transition-all active:scale-95 ${selectedRace === '400m' ? 'col-span-2' : ''}`}
                >
                  <History size={theme.size === 'xs' ? 10 : theme.size === 'small' ? 14 : 18} />
                  <span className={`${theme.size === 'xs' ? 'text-[7px]' : 'text-[9px]'} font-bold uppercase tracking-widest`}>Split</span>
                </button>

                {selectedRace !== '400m' && (
                  <button
                    onClick={() => recordLap(runner.id)}
                    disabled={runner.elapsedTime === 0}
                    className={`flex flex-col items-center justify-center gap-0.5 ${theme.size === 'xs' ? 'py-1 rounded-xl' : theme.size === 'small' ? 'py-2 rounded-2xl' : 'py-3 rounded-2xl'} ${theme.isDark ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-zinc-700' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700 border-zinc-200'} border disabled:opacity-30 disabled:pointer-events-none transition-all active:scale-95`}
                  >
                    <Plus size={theme.size === 'xs' ? 10 : theme.size === 'small' ? 14 : 18} />
                    <span className={`${theme.size === 'xs' ? 'text-[7px]' : 'text-[9px]'} font-bold uppercase tracking-widest`}>Lap</span>
                  </button>
                )}

                <button
                  onClick={() => resetRunner(runner.id)}
                  className={`flex flex-col items-center justify-center gap-0.5 ${theme.size === 'xs' ? 'py-1 rounded-xl' : theme.size === 'small' ? 'py-2 rounded-2xl' : 'py-3 rounded-2xl'} ${theme.isDark ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400 border-zinc-700' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-500 border-zinc-200'} border transition-all active:scale-95`}
                >
                  <Trash2 size={theme.size === 'xs' ? 10 : theme.size === 'small' ? 14 : 18} />
                  <span className={`${theme.size === 'xs' ? 'text-[7px]' : 'text-[9px]'} font-bold uppercase tracking-widest`}>Reset</span>
                </button>
              </div>
            </div>

            {/* Logs Section */}
            {runner.logs.length > 0 && (
              <div className={`border-t ${getBorderColorClass()}`}>
                <button
                  onClick={() => toggleExpand(runner.id)}
                  className={`w-full flex items-center justify-between ${theme.size === 'xs' ? 'px-2 py-1.5' : 'px-4 py-3'} text-xs font-black tracking-widest ${getMutedTextColorClass()} hover:bg-zinc-800/30 transition-colors`}
                >
                  <span className="flex items-center gap-2">
                    <History size={theme.size === 'xs' ? 10 : 14} />
                    {theme.layout !== 'grid' && `${runner.logs.length} RECORDED TIMES`}
                  </span>
                  {runner.isExpanded ? <ChevronUp size={theme.size === 'xs' ? 12 : 16} /> : <ChevronDown size={theme.size === 'xs' ? 12 : 16} />}
                </button>
                
                <AnimatePresence>
                  {runner.isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className={`overflow-hidden ${theme.isDark ? 'bg-zinc-950/50' : 'bg-zinc-100/50'}`}
                    >
                      <div className={`${theme.layout === 'grid' ? 'max-h-40' : 'max-h-80'} overflow-y-auto ${theme.size === 'xs' ? 'px-2 pb-2 space-y-1' : 'px-4 pb-6 space-y-4'}`}>
                        {runner.logs.map((log, i) => (
                          <div key={`${runner.id}-log-${i}`} className="relative overflow-hidden group">
                            {/* Delete Action Background */}
                            <div className="absolute inset-0 bg-red-600 flex items-center justify-end px-6">
                              <div className="flex flex-col items-center gap-1 text-white">
                                <Trash2 size={18} />
                                <span className="text-[8px] font-bold uppercase">Delete</span>
                              </div>
                            </div>

                            <motion.div
                              drag="x"
                              dragConstraints={{ left: -100, right: 0 }}
                              dragElastic={0.1}
                              onDragEnd={(_, info) => {
                                if (info.offset.x < -70) {
                                  removeLogEntry(runner.id, i);
                                }
                              }}
                              className={`relative flex items-center justify-between ${theme.size === 'xs' ? 'py-1' : theme.size === 'small' ? 'py-2' : 'py-4'} border-b ${getBorderColorClass()} last:border-0 ${getCardBgClass()} transition-colors`}
                            >
                              <div className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-2">
                                  <span className={`${theme.size === 'xs' ? 'text-[7px]' : 'text-[10px]'} font-black uppercase tracking-[0.2em] ${
                                    log.type === 'Split' ? 'text-blue-500' : 'text-emerald-500'
                                  }`}>
                                    {log.type} {log.number}
                                  </span>
                                  {log.pace && (
                                    <span className={`${theme.size === 'xs' ? 'text-[10px]' : 'text-sm'} font-black uppercase tracking-tight text-orange-500`}>
                                      • PROJ: {log.pace}
                                    </span>
                                  )}
                                  {log.prDelta !== undefined && (
                                    <span className={`${theme.size === 'xs' ? 'text-[10px]' : 'text-sm'} font-black uppercase tracking-tight ${log.prDelta >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                                      • {log.prDelta >= 0 ? '+' : ''}{(log.prDelta / 1000).toFixed(2)}s
                                    </span>
                                  )}
                                  {i === 0 && (
                                    <span className={`animate-pulse ${theme.size === 'xs' ? 'px-1 py-0' : 'px-2 py-0.5'} rounded-full ${getColorClass('bg500_10')} ${getColorClass('text')} ${theme.size === 'xs' ? 'text-[6px]' : 'text-[8px]'} font-black uppercase tracking-widest`}>
                                      New
                                    </span>
                                  )}
                                </div>
                                <div className={`${
                                  theme.size === 'xs' ? 'text-xl' : theme.size === 'small' ? 'text-2xl' : 'text-4xl'
                                } font-mono font-black tabular-nums tracking-tighter ${
                                  i === 0 ? getColorClass('text') : getTextColorClass()
                                } drop-shadow-sm`}>
                                  {log.formatted}
                                </div>
                                {log.type === 'Split' && log.formattedSinceLastSplit && (
                                  <div className={`${theme.size === 'xs' ? 'text-[8px]' : 'text-[10px]'} font-mono font-bold text-blue-500 tracking-tight`}>
                                    Since Last Split: {log.formattedSinceLastSplit}
                                  </div>
                                )}
                                <div className={`${theme.size === 'xs' ? 'text-[8px]' : 'text-[10px]'} font-mono font-bold ${getMutedTextColorClass()} tracking-tight`}>
                                  Total: {log.formattedCumulative}
                                </div>
                              </div>
                              <div className="flex items-center gap-3">
                                <div className={`${theme.size === 'xs' ? 'text-[8px]' : 'text-[10px]'} font-bold ${getMutedTextColorClass()} opacity-0 group-hover:opacity-100 transition-opacity`}>
                                  #{runner.logs.length - i}
                                </div>
                                <div className="md:hidden text-[8px] font-bold text-zinc-600 animate-pulse">
                                  ← Swipe
                                </div>
                              </div>
                            </motion.div>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </motion.div>
        ))}

        {/* Add Runner Button */}
        {(!sessionPin || isHost) && (
          <motion.button
            layout
            onClick={addRunner}
            className={`w-full py-6 rounded-3xl border-2 border-dashed ${getBorderColorClass()} ${getMutedTextColorClass()} ${getColorClass('hoverText500')} ${getColorClass('hoverBorder500_50')} ${getColorClass('hoverBg500_5')} transition-all flex flex-col items-center justify-center gap-2 group`}
          >
            <div className={`w-12 h-12 rounded-full ${getCardBgClass()} border ${getBorderColorClass()} flex items-center justify-center group-hover:scale-110 transition-transform`}>
              <Plus size={24} />
            </div>
            <span className="text-xs font-bold uppercase tracking-widest">Add New Runner</span>
          </motion.button>
        )}
        </main>
      ) : (
        <main className={`${getMaxWidthClass()} mx-auto p-4 pb-24`}>
          <div className={`${getCardBgClass()} rounded-3xl border ${getBorderColorClass()} p-6 shadow-xl`}>
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl font-bold tracking-tight">Team Roster</h2>
                <p className={`${getMutedTextColorClass()} text-sm`}>Manage athletes and their personal records.</p>
              </div>
              <div className="flex items-center gap-2">
                {roster.length > 0 && (
                  <button
                    onClick={() => {
                      if (confirm('Are you sure you want to clear the entire roster?')) {
                        roster.forEach(a => removeAthlete(a.id));
                      }
                    }}
                    className={`flex items-center gap-2 px-4 py-2 rounded-xl border ${getBorderColorClass()} ${getMutedTextColorClass()} hover:text-red-500 hover:border-red-500/50 transition-all text-xs font-bold`}
                  >
                    <Trash2 size={16} />
                    Clear All
                  </button>
                )}
                <button
                  onClick={() => {
                    const name = prompt('Enter athlete name:');
                    if (name) addAthlete(name);
                  }}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl ${getColorClass('bg600')} hover:bg-emerald-500 text-white font-bold transition-all shadow-lg shadow-emerald-900/20`}
                >
                  <Plus size={18} />
                  Add Athlete
                </button>
              </div>
            </div>

            <div className="space-y-4">
              {roster.length === 0 ? (
                <div className={`text-center py-12 border-2 border-dashed ${getBorderColorClass()} rounded-2xl`}>
                  <Users size={48} className={`mx-auto ${getMutedTextColorClass()} mb-4 opacity-20`} />
                  <p className={getMutedTextColorClass()}>No athletes in roster yet.</p>
                </div>
              ) : (
                roster.map((athlete) => (
                  <div key={athlete.id} className={`p-4 rounded-2xl border ${getBorderColorClass()} ${theme.isDark ? 'bg-zinc-800/50' : 'bg-zinc-50'} flex flex-col gap-4`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-full ${getColorClass('bg500_10')} flex items-center justify-center`}>
                          <User className={getColorClass('text')} size={20} />
                        </div>
                        <div>
                          <h3 className="text-lg font-bold">{athlete.name}</h3>
                          {(() => {
                            const activeRunner = runners.find(r => r.athleteId === athlete.id);
                            if (activeRunner) {
                              const currentDist = getTotalDistance(activeRunner.logs, selectedRace);
                              const pace = activeRunner.logs[0]?.pace || (activeRunner.isRunning ? calculateProjectedTime(activeRunner.elapsedTime, currentDist, selectedRace) : null);
                              if (pace) {
                                return (
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                                    <span className="text-[10px] font-black uppercase tracking-widest text-emerald-500">Live Pace: {pace}</span>
                                  </div>
                                );
                              }
                            }
                            return null;
                          })()}
                        </div>
                      </div>
                      <button
                        onClick={() => removeAthlete(athlete.id)}
                        className="p-2 text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {(['400m', '800m', '1600m', '3200m'] as RaceType[]).map((race) => (
                        <div key={race} className={`p-3 rounded-xl border ${getBorderColorClass()} ${getCardBgClass()}`}>
                          <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">{race} PR</div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-sm">
                              {athlete.prs[race] ? formatTime(athlete.prs[race]!) : '--:--.--'}
                            </span>
                            <button
                              onClick={() => {
                                const timeStr = prompt(`Enter ${race} PR (MM:SS.ss):`, athlete.prs[race] ? formatTime(athlete.prs[race]!) : '');
                                if (timeStr) {
                                  const parts = timeStr.split(/[:.]/);
                                  if (parts.length >= 2) {
                                    const mins = parseInt(parts[0]) || 0;
                                    const secs = parseInt(parts[1]) || 0;
                                    const ms = parseInt(parts[2]) || 0;
                                    const totalMs = (mins * 60000) + (secs * 1000) + (ms * 10);
                                    updateAthletePR(athlete.id, race, totalMs);
                                  }
                                }
                              }}
                              className={`p-1 rounded hover:bg-zinc-800 ${getColorClass('text')} transition-colors`}
                            >
                              <Settings size={14} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </main>
      )}

      {/* Race Selection Dropdown */}
      <div className={`${getMaxWidthClass()} mx-auto px-4 pb-12`}>
        <div className={`p-6 rounded-3xl border ${getBorderColorClass()} ${getCardBgClass()} shadow-lg`}>
          <label className={`text-[10px] font-bold uppercase tracking-widest ${getMutedTextColorClass()} mb-3 block`}>
            Race Selection
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {(['None', '400m', '800m', '1600m', '3200m'] as RaceType[]).map((race) => (
              <button
                key={race}
                onClick={() => handleRaceSelection(race)}
                disabled={sessionPin ? !isHost : false}
                className={`px-4 py-3 rounded-xl border-2 text-[10px] font-bold uppercase tracking-widest transition-all ${
                  selectedRace === race
                    ? `${getColorClass('border500')} ${getColorClass('bg500_10')} ${getColorClass('text')}`
                    : `${getBorderColorClass()} ${getMutedTextColorClass()} hover:border-zinc-500`
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {race === 'None' ? 'None' : race.replace('m', ' meters')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Export Modal */}
      <AnimatePresence>
        {exportModal.isOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !isExporting && setExportModal({ isOpen: false })}
              className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[70] ${getCardBgClass()} border ${getBorderColorClass()} rounded-[2.5rem] p-8 shadow-2xl w-[90%] max-w-md`}
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold">Export to Sheets</h2>
                {!isExporting && (
                  <button
                    onClick={() => setExportModal({ isOpen: false })}
                    className={`p-2 rounded-full ${theme.isDark ? 'bg-zinc-800' : 'bg-zinc-100'} ${getMutedTextColorClass()}`}
                  >
                    <X size={20} />
                  </button>
                )}
              </div>

              {exportResult ? (
                <div className="text-center space-y-6">
                  <div className={`w-16 h-16 rounded-full ${getColorClass('bg500_10')} ${getColorClass('text')} flex items-center justify-center mx-auto`}>
                    <Check size={32} />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold mb-2">Export Successful!</h3>
                    <p className={`text-sm ${getMutedTextColorClass()}`}>Your data has been saved to a new Google Sheet.</p>
                  </div>
                  <a
                    href={exportResult.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`flex items-center justify-center gap-2 w-full py-4 rounded-2xl ${getColorClass('bg600')} hover:bg-${theme.color}-500 text-white font-bold transition-all`}
                  >
                    <ExternalLink size={18} />
                    Open Spreadsheet
                  </a>
                  <button
                    onClick={() => setExportModal({ isOpen: false })}
                    className={`w-full py-4 rounded-2xl ${theme.isDark ? 'bg-zinc-800 hover:bg-zinc-700' : 'bg-zinc-100 hover:bg-zinc-200'} font-bold transition-all`}
                  >
                    Close
                  </button>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="space-y-4">
                    <div>
                      <label className={`text-[10px] font-bold uppercase tracking-widest ${getMutedTextColorClass()} mb-2 block`}>Race Name</label>
                      <input
                        type="text"
                        value={exportData.raceName}
                        onChange={(e) => setExportData(d => ({ ...d, raceName: e.target.value }))}
                        className={`w-full px-4 py-3 rounded-xl ${theme.isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-zinc-100 border-zinc-200'} border focus:ring-2 focus:ring-${theme.color}-500 outline-none transition-all`}
                        placeholder="e.g. 100m Sprint Finals"
                        disabled={isExporting}
                      />
                    </div>
                    <div>
                      <label className={`text-[10px] font-bold uppercase tracking-widest ${getMutedTextColorClass()} mb-2 block`}>Meet Name (Optional)</label>
                      <input
                        type="text"
                        value={exportData.meetName}
                        onChange={(e) => setExportData(d => ({ ...d, meetName: e.target.value }))}
                        className={`w-full px-4 py-3 rounded-xl ${theme.isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-zinc-100 border-zinc-200'} border focus:ring-2 focus:ring-${theme.color}-500 outline-none transition-all`}
                        placeholder="e.g. City Championships"
                        disabled={isExporting}
                      />
                    </div>
                  </div>

                  <button
                    onClick={() => performExport()}
                    disabled={!exportData.raceName || isExporting}
                    className={`flex items-center justify-center gap-2 w-full py-4 rounded-2xl ${getColorClass('bg600')} hover:bg-${theme.color}-500 text-white font-bold transition-all disabled:opacity-50 disabled:pointer-events-none`}
                  >
                    {isExporting ? (
                      <>
                        <Loader2 size={18} className="animate-spin" />
                        Exporting...
                      </>
                    ) : (
                      <>
                        <Download size={18} />
                        Export to Google Sheets
                      </>
                    )}
                  </button>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {isSettingsOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsSettingsOpen(false)}
              className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className={`fixed bottom-0 left-0 right-0 z-[70] ${getCardBgClass()} border-t ${getBorderColorClass()} rounded-t-[2.5rem] p-6 pb-12 shadow-2xl max-w-2xl mx-auto`}
            >
              <div className="flex items-center justify-between mb-8">
                <h2 className="text-xl font-bold">Settings</h2>
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className={`p-2 rounded-full ${theme.isDark ? 'bg-zinc-800' : 'bg-zinc-100'} ${getMutedTextColorClass()}`}
                >
                  <X size={20} />
                </button>
              </div>

              <div className="space-y-8">
                {/* Stopwatch Size */}
                <section>
                  <h3 className={`text-[10px] font-bold uppercase tracking-widest ${getMutedTextColorClass()} mb-4`}>Stopwatch Size</h3>
                  <div className={`grid grid-cols-4 gap-2 p-1 rounded-2xl ${theme.isDark ? 'bg-zinc-950' : 'bg-zinc-100'}`}>
                    {(['xs', 'small', 'medium', 'large'] as StopwatchSize[]).map((s) => (
                      <button
                        key={s}
                        onClick={() => setTheme(t => ({ ...t, size: s }))}
                        className={`flex items-center justify-center py-2 rounded-xl transition-all ${theme.size === s ? `${getCardBgClass()} shadow-sm ${getTextColorClass()}` : 'text-zinc-500'}`}
                      >
                        <span className="text-[10px] font-bold uppercase">{s}</span>
                      </button>
                    ))}
                  </div>
                </section>

                {/* Layout Stacking */}
                <section>
                  <h3 className={`text-[10px] font-bold uppercase tracking-widest ${getMutedTextColorClass()} mb-4`}>Layout Stacking</h3>
                  <div className={`grid grid-cols-2 gap-3 p-1 rounded-2xl ${theme.isDark ? 'bg-zinc-950' : 'bg-zinc-100'}`}>
                    <button
                      onClick={() => setTheme(t => ({ ...t, layout: 'stack' }))}
                      className={`flex items-center justify-center gap-2 py-3 rounded-xl transition-all ${theme.layout === 'stack' ? `${getCardBgClass()} shadow-sm ${getTextColorClass()}` : 'text-zinc-500'}`}
                    >
                      <div className="flex flex-col gap-0.5">
                        <div className="w-4 h-1 bg-current rounded-full opacity-40" />
                        <div className="w-4 h-1 bg-current rounded-full" />
                      </div>
                      <span className="text-sm font-bold">List</span>
                    </button>
                    <button
                      onClick={() => setTheme(t => ({ ...t, layout: 'grid' }))}
                      className={`flex items-center justify-center gap-2 py-3 rounded-xl transition-all ${theme.layout === 'grid' ? `${getCardBgClass()} shadow-sm ${getTextColorClass()}` : 'text-zinc-500'}`}
                    >
                      <div className="grid grid-cols-2 gap-0.5">
                        <div className="w-1.5 h-1.5 bg-current rounded-sm opacity-40" />
                        <div className="w-1.5 h-1.5 bg-current rounded-sm" />
                        <div className="w-1.5 h-1.5 bg-current rounded-sm" />
                        <div className="w-1.5 h-1.5 bg-current rounded-sm opacity-40" />
                      </div>
                      <span className="text-sm font-bold">Grid</span>
                    </button>
                  </div>
                </section>

                {/* Appearance */}
                <section>
                  <h3 className={`text-[10px] font-bold uppercase tracking-widest ${getMutedTextColorClass()} mb-4`}>Appearance</h3>
                  <div className={`grid grid-cols-2 gap-3 p-1 rounded-2xl ${theme.isDark ? 'bg-zinc-950' : 'bg-zinc-100'}`}>
                    <button
                      onClick={() => setTheme(t => ({ ...t, isDark: false }))}
                      className={`flex items-center justify-center gap-2 py-3 rounded-xl transition-all ${!theme.isDark ? `${getCardBgClass()} shadow-sm text-zinc-900` : 'text-zinc-500'}`}
                    >
                      <Sun size={18} />
                      <span className="text-sm font-bold">Light</span>
                    </button>
                    <button
                      onClick={() => setTheme(t => ({ ...t, isDark: true }))}
                      className={`flex items-center justify-center gap-2 py-3 rounded-xl transition-all ${theme.isDark ? `${getCardBgClass()} shadow-sm text-zinc-100` : 'text-zinc-500'}`}
                    >
                      <Moon size={18} />
                      <span className="text-sm font-bold">Dark</span>
                    </button>
                  </div>
                </section>

                {/* Color Theme */}
                <section>
                  <h3 className={`text-[10px] font-bold uppercase tracking-widest ${getMutedTextColorClass()} mb-4`}>Color Theme</h3>
                  <div className="grid grid-cols-3 gap-3">
                    {THEME_COLORS.map((color) => (
                      <button
                        key={color.value}
                        onClick={() => setTheme(t => ({ ...t, color: color.value }))}
                        className={`flex flex-col items-center gap-2 p-3 rounded-2xl border-2 transition-all ${
                          theme.color === color.value 
                            ? `${getColorClass('border500')} ${getColorClass('bg500_10')}` 
                            : `${getBorderColorClass()} hover:border-zinc-500`
                        }`}
                      >
                        <div className={`w-8 h-8 rounded-full ${color.class} shadow-inner flex items-center justify-center text-white`}>
                          {theme.color === color.value && <Check size={16} strokeWidth={3} />}
                        </div>
                        <span className="text-[10px] font-bold uppercase tracking-tight">{color.name}</span>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Multi-Coach Modal */}
      <AnimatePresence>
        {isMultiCoachModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMultiCoachModalOpen(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className={`relative w-full max-w-sm ${getCardBgClass()} rounded-3xl p-8 shadow-2xl border ${getBorderColorClass()}`}
            >
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-xl ${getColorClass('bg500_10')}`}>
                    <Users className={getColorClass('text')} size={24} />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold tracking-tight">Multi-Coach</h2>
                    <p className={`text-[10px] font-bold ${getMutedTextColorClass()} uppercase tracking-widest`}>Synchronized Timing</p>
                  </div>
                </div>
                <button 
                  onClick={() => setIsMultiCoachModalOpen(false)}
                  className={`p-2 ${getMutedTextColorClass()} hover:bg-zinc-800 rounded-xl transition-colors`}
                >
                  <X size={20} />
                </button>
              </div>

              {!sessionPin ? (
                <div className="space-y-6">
                  <div className="space-y-3">
                    <button
                      onClick={hostSession}
                      className={`w-full flex items-center justify-center gap-3 ${getColorClass('bg600')} ${getColorClass('hoverBg500')} text-white font-bold py-4 rounded-2xl transition-all shadow-lg ${getColorClass('shadow900_20')}`}
                    >
                      <Share2 size={18} />
                      Host a New Race
                    </button>
                    <p className={`text-center text-[10px] ${getMutedTextColorClass()} font-medium`}>Generate a PIN for other coaches to join</p>
                  </div>

                  <div className="relative flex items-center py-2">
                    <div className={`flex-grow border-t ${getBorderColorClass()}`}></div>
                    <span className={`flex-shrink mx-4 text-[10px] font-bold ${getMutedTextColorClass()} uppercase tracking-widest`}>OR</span>
                    <div className={`flex-grow border-t ${getBorderColorClass()}`}></div>
                  </div>

                  <div className="space-y-3">
                    <div className="relative">
                      <input
                        type="text"
                        placeholder="Enter 4-Digit PIN"
                        value={joinPin}
                        onChange={(e) => setJoinPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        className={`w-full ${theme.isDark ? 'bg-zinc-800' : 'bg-zinc-100'} border ${getBorderColorClass()} rounded-2xl px-5 py-4 text-center text-lg font-bold tracking-[0.5em] focus:outline-none focus:ring-2 ${getColorClass('ring500')} transition-all placeholder:tracking-normal placeholder:text-sm placeholder:font-medium`}
                      />
                    </div>
                    <button
                      onClick={joinSession}
                      disabled={joinPin.length !== 4}
                      className={`w-full flex items-center justify-center gap-3 ${joinPin.length === 4 ? (theme.isDark ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-900 text-white') : 'bg-zinc-800 text-zinc-500 opacity-50 cursor-not-allowed'} font-bold py-4 rounded-2xl transition-all`}
                    >
                      Join Existing Race
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className={`p-6 rounded-2xl ${theme.isDark ? 'bg-zinc-800/50' : 'bg-zinc-100'} border ${getBorderColorClass()} text-center`}>
                    <p className={`text-[10px] font-bold ${getMutedTextColorClass()} uppercase tracking-widest mb-2`}>Active Session PIN</p>
                    <h3 className={`text-4xl font-black tracking-[0.2em] ${getColorClass('text')}`}>{sessionPin}</h3>
                    <p className={`mt-4 text-[11px] font-medium ${getTextColorClass()}`}>
                      {isHost ? 'You are the host coach' : 'You are a guest coach'}
                    </p>
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                      <span className={`px-2 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider ${sessionData?.status === 'active' ? 'bg-emerald-500/20 text-emerald-500' : 'bg-amber-500/20 text-amber-500'}`}>
                        {sessionData?.status === 'active' ? 'Race Active' : 'Waiting for Host'}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={leaveSession}
                    className={`w-full flex items-center justify-center gap-3 bg-red-500/10 hover:bg-red-500/20 text-red-500 font-bold py-4 rounded-2xl transition-all border border-red-500/20`}
                  >
                    <LogOut size={18} />
                    Leave Session
                  </button>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Footer Info */}
      <footer className={`fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t ${theme.isDark ? 'from-zinc-950' : 'from-zinc-50'} to-transparent pointer-events-none`}>
        <div className="max-w-2xl mx-auto text-center">
          <p className={`text-[10px] ${getMutedTextColorClass()} font-bold tracking-[0.2em] uppercase`}>
            High Precision Timing Engine Active
          </p>
        </div>
      </footer>

    </div>
  );
}
