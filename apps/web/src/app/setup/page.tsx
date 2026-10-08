"use client";

import { Suspense } from "react";
import { useSetup } from "./use-setup";
import { SetupProgress } from "./setup-progress";
import { LlmCheckStep } from "./llm-check-step";
import { ContentStep } from "./content-step";
import { DiscoveryStep } from "./discovery-step";
import { TemplateStep } from "./template-step";
import { HabitInterviewStep } from "./habit-interview-step";
import { CanvasLoginModal } from "../new/canvas-login-modal";

function SetupInner() {
  const s = useSetup();

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-xl flex flex-col gap-8 animate-fade-in">
        {/* Header */}
        <div className="flex flex-col items-center gap-4">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-brand text-2xl font-black text-brand-foreground shadow-md">
            {s.t("brand.mark")}
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">{s.t("brand.name")}</h1>
            {s.t("brand.name") !== "Lumate" && (
              <p className="mt-1 text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">Lumate</p>
            )}
          </div>
          <SetupProgress currentStep={s.step} t={s.t} />
        </div>

        {/* Step content */}
        <div className="rounded-2xl bg-card p-8 card-shadow">
          {s.step === "llm" && (
            <LlmCheckStep
              llmReady={s.llmReady}
              llmChecking={s.llmChecking}
              health={s.health}
              provider={s.llmProvider}
              onProviderChange={s.setLlmProvider}
              model={s.llmModel}
              onModelChange={s.setLlmModel}
              apiKey={s.llmApiKey}
              onApiKeyChange={s.setLlmApiKey}
              baseUrl={s.llmBaseUrl}
              onBaseUrlChange={s.setLlmBaseUrl}
              testing={s.llmTesting}
              testError={s.llmTestError}
              onTest={s.testAndSaveLlm}
              onSkip={() => s.setStep("content")}
              t={s.t}
            />
          )}

          {s.step === "content" && (
            <ContentStep
              projectName={s.projectName}
              onProjectNameChange={s.setProjectName}
              nameError={s.nameError}
              onValidateName={s.validateName}
              files={s.files}
              onFilesChange={s.setFiles}
              url={s.url}
              onUrlChange={s.setUrl}
              urlError={s.urlError}
              onValidateUrl={s.validateUrl}
              autoScrape={s.autoScrape}
              onAutoScrapeChange={s.setAutoScrape}
              isCanvasDetected={s.isCanvasDetected}
              canvasSessionValid={s.canvasSessionValid}
              canvasAuthenticating={s.canvasLogging}
              onAuthCanvas={s.handleAuthCanvas}
              onQuickStart={s.quickStart}
              quickStartLoading={s.quickStartLoading}
              onStartLearning={s.startLearning}
              onSkip={s.skipContent}
              t={s.t}
            />
          )}

          {s.step === "interview" && (
            <HabitInterviewStep
              onComplete={s.acceptInterviewLayout}
              onSkip={s.skipInterview}
              onBack={() => s.setStep("content")}
              t={s.t}
            />
          )}

          {s.step === "template" && (
            <TemplateStep
              selectedTemplate={s.selectedTemplate}
              onSelect={s.setSelectedTemplate}
              selectedMode={s.selectedMode}
              onModeSelect={s.setSelectedMode}
              onConfirm={s.confirmTemplate}
              onBack={() => s.setStep("interview")}
              t={s.t}
            />
          )}

          {s.step === "discovery" && (
            <DiscoveryStep
              parseSteps={s.parseSteps}
              parseProgress={s.parseProgress}
              parseLogs={s.parseLogs}
              hasCompletedJob={s.hasCompletedJob}
              allJobsFailed={s.allJobsFailed}
              noSourcesSubmitted={s.noSourcesSubmitted}
              aiProbeResponse={s.aiProbeResponse}
              aiProbeStreaming={s.aiProbeStreaming}
              aiProbeDone={s.aiProbeDone}
              canEnterEarly={s.canEnterEarly}
              onEnterWorkspace={s.enterWorkspace}
              t={s.t}
            />
          )}
        </div>
      </div>

      {/* Canvas login modal */}
      {s.showCanvasLogin && (
        <CanvasLoginModal
          url={s.url}
          canvasLogging={s.canvasLogging}
          canvasLoginError={s.canvasLoginError}
          onClose={() => s.setShowCanvasLogin(false)}
          onRetry={s.handleAuthCanvas}
          t={s.t}
        />
      )}
    </div>
  );
}

export default function SetupPage() {
  return (
    <Suspense>
      <SetupInner />
    </Suspense>
  );
}
