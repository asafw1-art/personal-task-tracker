import type { TaskPrefix, TaskPriority, TaskStatus, TaskSubtaskStatus } from "@/lib/tasks";

export type AssistantMessageRole = "user" | "assistant";
export type AssistantActionStatus = "proposed" | "approved" | "done" | "failed";

export type AssistantProposedAction =
  | {
      type: "create_task";
      label: string;
      task: {
        prefix?: TaskPrefix;
        title: string;
        category?: string;
        actionType?: string;
        priority?: TaskPriority;
        dueDate?: string;
        notes?: string;
      };
    }
  | {
      type: "update_task_status";
      label: string;
      taskId: string;
      status: TaskStatus;
    }
  | {
      type: "add_subtask";
      label: string;
      taskId: string;
      subtask: {
        title: string;
        actionType?: string;
      };
    }
  | {
      type: "update_subtask_status";
      label: string;
      taskId: string;
      subtaskNumber: number;
      status: TaskSubtaskStatus;
    }
  | {
      type: "filter_tasks";
      label: string;
      filter: {
        query?: string;
        statusFilter?: string;
        prefixFilter?: string;
        topicFilter?: string;
        actionFilter?: string;
      };
    };

export type AssistantThread = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type AssistantMessage = {
  id: string;
  threadId: string;
  role: AssistantMessageRole;
  content: string;
  proposedAction?: AssistantProposedAction;
  actionStatus?: AssistantActionStatus;
  createdAt: string;
};

export type AssistantResponse = {
  reply: string;
  proposedAction?: AssistantProposedAction;
};
