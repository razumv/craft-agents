// SPDX-License-Identifier: Apache-2.0

import type { IssueContract, RiskTier, VerificationBudget, WorkflowConfig } from "./domain";

export class ModelPolicy {
  constructor(private readonly config: WorkflowConfig["model"]) {}

  assertAllowed(profile: string): void {
    if (this.config.connection !== "chatgpt-plus" || !/^pi\/gpt-/i.test(profile) || !this.config.allowedProfiles.includes(profile)) {
      throw new Error(`model policy rejected ${this.config.connection}/${profile}`);
    }
  }
}

export class RiskPolicy {
  constructor(private readonly budgets: Record<RiskTier, VerificationBudget>) {}

  budgetFor(contract: IssueContract): VerificationBudget {
    const budget = this.budgets[contract.risk];
    if (contract.verificationBudget !== budget.budget) throw new Error("issue verification budget does not match risk tier");
    return { ...budget };
  }

  assertIndependentReviewAllowed(contract: IssueContract, completedReviews: number): void {
    const budget = this.budgetFor(contract);
    if (budget.independentReviews === 0) throw new Error("independent audit is forbidden for low-risk work");
    if (completedReviews >= budget.independentReviews) throw new Error("verification budget forbids an audit loop");
  }

  assertCorrectionAllowed(contract: IssueContract, completedCorrections: number): void {
    const budget = this.budgetFor(contract);
    if (completedCorrections >= budget.correctionPasses) throw new Error("verification budget forbids another correction pass");
  }
}
