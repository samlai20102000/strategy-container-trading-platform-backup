ALTER TABLE `strategies`
  MODIFY COLUMN `activationState` ENUM(
    'LEGACY',
    'DRAFT',
    'DISABLED',
    'PREFLIGHT_FAILED',
    'READY_DISABLED',
    'ARMED',
    'ACTIVE',
    'PAUSED',
    'DRAINING',
    'BLOCKED',
    'ARCHIVED'
  ) NOT NULL DEFAULT 'LEGACY';

ALTER TABLE `strategies` ADD COLUMN `deploymentRevision` INT NOT NULL DEFAULT 1;
ALTER TABLE `strategies` ADD COLUMN `preflightStatus` ENUM('NOT_RUN', 'PASSED', 'FAILED', 'STALE') NOT NULL DEFAULT 'NOT_RUN';
ALTER TABLE `strategies` ADD COLUMN `preflightReport` JSON NULL;
ALTER TABLE `strategies` ADD COLUMN `preflightHash` VARCHAR(64) NULL;
ALTER TABLE `strategies` ADD COLUMN `preflightCheckedAt` TIMESTAMP NULL;
ALTER TABLE `strategies` ADD COLUMN `lifecycleReasonCode` VARCHAR(80) NULL;
ALTER TABLE `strategies` ADD COLUMN `lifecycleReason` TEXT NULL;
ALTER TABLE `strategies` ADD COLUMN `archivedAt` TIMESTAMP NULL;

CREATE TABLE IF NOT EXISTS `mode_transitions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `transitionKey` VARCHAR(128) NOT NULL,
  `deploymentId` INT NOT NULL,
  `userId` INT NOT NULL,
  `fromState` VARCHAR(32) NOT NULL,
  `toState` VARCHAR(32) NOT NULL,
  `fromMode` VARCHAR(32) NOT NULL,
  `toMode` VARCHAR(32) NOT NULL,
  `fromPolicyHash` VARCHAR(64) NULL,
  `toPolicyHash` VARCHAR(64) NULL,
  `expectedRevision` INT NOT NULL,
  `resultingRevision` INT NULL,
  `status` ENUM('PENDING', 'APPLIED', 'BLOCKED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
  `reasonCode` VARCHAR(80) NOT NULL,
  `reason` TEXT NOT NULL,
  `blockerCodes` JSON NULL,
  `preflightReport` JSON NULL,
  `requestedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completedAt` TIMESTAMP NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `mode_transitions_transition_key_uq` (`transitionKey`),
  KEY `mode_transitions_deployment_created_idx` (`deploymentId`, `createdAt`),
  KEY `mode_transitions_user_status_idx` (`userId`, `status`)
);
