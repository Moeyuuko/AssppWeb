import { create } from 'zustand';

type SigningStage = 'idle' | 'assets' | 'initializing' | 'ready' | 'error';
interface SigningState {
  stage: SigningStage;
  percent: number;
  update: (stage: SigningStage, percent?: number) => void;
}

export const useSapStore = create<SigningState>((set) => ({
  stage: 'idle',
  percent: 0,
  update: (stage, percent = 0) => set({ stage, percent }),
}));
