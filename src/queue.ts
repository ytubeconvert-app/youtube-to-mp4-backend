export interface Job {
  id: string;
  videoId: string;
  url: string;
  format: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;
  message?: string;
  outputPath?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

class JobQueue {
  private jobs: Map<string, Job> = new Map();
  private maxConcurrent: number = parseInt(process.env.MAX_CONCURRENT_JOBS || '4', 10);
  private activeJobs: number = 0;

  public createJob(id: string, videoId: string, url: string, format: string): Job {
    const job: Job = {
      id,
      videoId,
      url,
      format,
      status: 'queued',
      progress: 5,
      createdAt: Date.now()
    };
    this.jobs.set(id, job);
    return job;
  }

  public getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  public updateJob(id: string, updates: Partial<Job>) {
    const job = this.jobs.get(id);
    if (job) {
      Object.assign(job, updates);
    }
  }

  public canProcessNext(): boolean {
    return this.activeJobs < this.maxConcurrent;
  }

  public incrementActive() {
    this.activeJobs++;
  }

  public decrementActive() {
    this.activeJobs = Math.max(0, this.activeJobs - 1);
  }
}

export const queue = new JobQueue();
