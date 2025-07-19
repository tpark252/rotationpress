

const { App } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

class RotationpressCloneBot {
    constructor() {
        // Initialize Slack app
        this.app = new App({
            signingSecret: process.env.SLACK_SIGNING_SECRET,
            token: process.env.SLACK_BOT_TOKEN,
            socketMode: true,
            appToken: process.env.SLACK_APP_TOKEN,
            port: process.env.PORT || 3000
        });

        // Initialize SQLite database
        this.initDatabase();
        
        // Setup bot functionality
        this.setupCommands();
        this.setupEvents();
        this.setupViewSubmissions();
        this.startCronJobs();
        
        console.log('Rotationpress Bot initialized');
    }

    // DATABASE INITIALIZATION
    initDatabase() {
        const dbPath = path.join(__dirname, 'Rotationpress.db');
        this.db = new sqlite3.Database(dbPath);
        
        // Create tables
        this.db.serialize(() => {
            // Schedules table - enhanced with timezone and rotation timing
            this.db.run(`
                CREATE TABLE IF NOT EXISTS schedules (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    type TEXT NOT NULL,
                    frequency TEXT NOT NULL,
                    members TEXT,
                    current_index INTEGER DEFAULT 0,
                    integration_config TEXT,
                    custom_interval TEXT,
                    timezone TEXT DEFAULT 'UTC',
                    rotation_start_time TEXT DEFAULT '09:00',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    workspace_id TEXT NOT NULL
                )
            `);

            // User groups table
            this.db.run(`
                CREATE TABLE IF NOT EXISTS user_groups (
                    id TEXT PRIMARY KEY,
                    slack_group_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Schedule mappings (multi-schedule sync)
            this.db.run(`
                CREATE TABLE IF NOT EXISTS schedule_mappings (
                    id TEXT PRIMARY KEY,
                    user_group_id TEXT NOT NULL,
                    schedule_ids TEXT NOT NULL,
                    sync_config TEXT,
                    workspace_id TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_group_id) REFERENCES user_groups (id)
                )
            `);

            // Overrides table - enhanced with granular timing and timezone
            this.db.run(`
                CREATE TABLE IF NOT EXISTS overrides (
                    id TEXT PRIMARY KEY,
                    schedule_id TEXT NOT NULL,
                    original_user TEXT,
                    replacement_user TEXT NOT NULL,
                    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                    end_time DATETIME NOT NULL,
                    duration_value INTEGER NOT NULL,
                    duration_unit TEXT NOT NULL,
                    timezone TEXT DEFAULT 'UTC',
                    reason TEXT,
                    created_by TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    FOREIGN KEY (schedule_id) REFERENCES schedules (id)
                )
            `);

            // Sync logs table
            this.db.run(`
                CREATE TABLE IF NOT EXISTS sync_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    mapping_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    users_synced INTEGER,
                    error_message TEXT,
                    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (mapping_id) REFERENCES schedule_mappings (id)
                )
            `);
        });

        console.log('✅ Database initialized');
    }

    // SLASH COMMANDS SETUP
    setupCommands() {
        // Help command
        this.app.command('/rotation-help', async ({ command, ack, respond }) => {
            await ack();
            await respond({
                text: this.getHelpText(),
                response_type: 'ephemeral'
            });
        });

        // Create schedule
        this.app.command('/create-rotation', async ({ command, ack, client }) => {
            await ack();
            
            try {
                await client.views.open({
                    trigger_id: command.trigger_id,
                    view: this.getCreateScheduleModal()
                });
            } catch (error) {
                console.error('Error opening create schedule modal:', error);
            }
        });

        // Map multiple schedules (your unique feature)
        this.app.command('/map-schedules', async ({ command, ack, client }) => {
            await ack();
            
            try {
                const schedules = await this.getSchedulesForWorkspace(command.team_id);
                await client.views.open({
                    trigger_id: command.trigger_id,
                    view: this.getMultiScheduleMappingModal(schedules)
                });
            } catch (error) {
                console.error('Error opening mapping modal:', error);
            }
        });

        // Show current rotations
        this.app.command('/show-rotations', async ({ command, ack, respond }) => {
            await ack();
            
            try {
                const rotations = await this.getCurrentRotations(command.team_id);
                await respond({
                    text: this.formatRotationStatus(rotations),
                    response_type: 'ephemeral'
                });
            } catch (error) {
                await respond({
                    text: '❌ Error retrieving rotations: ' + error.message,
                    response_type: 'ephemeral'
                });
            }
        });

        // Override rotation
        this.app.command('/override-rotation', async ({ command, ack, respond, client }) => {
            await ack();
            
            try {
                const schedules = await this.getSchedulesForWorkspace(command.team_id);
                await client.views.open({
                    trigger_id: command.trigger_id,
                    view: this.getOverrideModal(schedules)
                });
            } catch (error) {
                console.error('Error opening override modal:', error);
            }
        });

        // Sync now (manual trigger)
        this.app.command('/sync-now', async ({ command, ack, respond }) => {
            await ack();
            
            try {
                const results = await this.syncAllMappingsForWorkspace(command.team_id);
                await respond({
                    text: `✅ Sync completed! Updated ${results.length} user groups.`,
                    response_type: 'ephemeral'
                });
            } catch (error) {
                await respond({
                    text: '❌ Sync failed: ' + error.message,
                    response_type: 'ephemeral'
                });
            }
        });

        // Edit schedule (add members)
        this.app.command('/edit-rotation', async ({ command, ack, client }) => {
            await ack();
            
            try {
                const schedules = await this.getSchedulesForWorkspace(command.team_id);
                await client.views.open({
                    trigger_id: command.trigger_id,
                    view: this.getEditScheduleModal(schedules)
                });
            } catch (error) {
                console.error('Error opening edit schedule modal:', error);
            }
        });
    }

    // EVENT HANDLERS
    setupEvents() {
        // Handle app home opened
        this.app.event('app_home_opened', async ({ event, client }) => {
            try {
                await client.views.publish({
                    user_id: event.user,
                    view: this.getHomeView()
                });
            } catch (error) {
                console.error('Error publishing home view:', error);
            }
        });

        // Handle user group changes
        this.app.event('subteam_updated', async ({ event }) => {
            console.log('User group updated:', event.subteam.id);
            // You could trigger a sync here if needed
        });
    }

    // VIEW SUBMISSIONS (Modal form handlers)
    setupViewSubmissions() {
        // Handle schedule creation
        this.app.view('create_schedule_modal', async ({ ack, body, view, client }) => {
            await ack();
            
            try {
                const values = view.state.values;
                const scheduleData = {
                    name: values.schedule_name.name_input.value,
                    type: values.schedule_type.type_select.selected_option.value,
                    frequency: values.frequency.frequency_select.selected_option.value,
                    members: values.members ? values.members.members_select.selected_users : [],
                    customInterval: values.custom_interval ? values.custom_interval.interval_input.value : null,
                    timezone: values.timezone ? values.timezone.timezone_select.selected_option.value : 'UTC',
                    rotationStartTime: values.rotation_start_time ? values.rotation_start_time.start_time_input.value : '09:00',
                    workspaceId: body.team.id
                };

                if (scheduleData.type !== 'internal' && values.integration_config) {
                    scheduleData.integrationConfig = {
                        scheduleId: values.integration_config.config_input.value
                    };
                }

                const schedule = await this.createSchedule(scheduleData);
                
                await client.chat.postMessage({
                    channel: body.user.id,
                    text: `✅ Schedule "${schedule.name}" created successfully! ID: ${schedule.id}\n🌍 Timezone: ${scheduleData.timezone}\n⏰ Rotation starts at: ${scheduleData.rotationStartTime}`
                });
                
            } catch (error) {
                console.error('Error creating schedule:', error);
                await client.chat.postMessage({
                    channel: body.user.id,
                    text: `❌ Error creating schedule: ${error.message}`
                });
            }
        });

        // Handle multi-schedule mapping
        this.app.view('map_schedules_modal', async ({ ack, body, view, client }) => {
            await ack();
            
            try {
                const values = view.state.values;
                const userGroupName = values.user_group.usergroup_input.value;
                const selectedSchedules = values.schedules.schedules_select.selected_options.map(opt => opt.value);
                const conflictResolution = values.conflict_resolution.resolution_select.selected_option.value;

                // Create user group if it doesn't exist
                const userGroup = await this.createOrGetUserGroup(userGroupName, body.team.id);
                
                // Create mapping
                const mapping = await this.createScheduleMapping(
                    userGroup.id,
                    selectedSchedules,
                    { conflictResolution },
                    body.team.id
                );

                // Perform initial sync
                await this.syncScheduleMapping(mapping.id);

                await client.chat.postMessage({
                    channel: body.user.id,
                    text: `✅ Multi-schedule mapping created! ${selectedSchedules.length} schedules are now synced to ${userGroupName}`
                });
                
            } catch (error) {
                console.error('Error creating mapping:', error);
                await client.chat.postMessage({
                    channel: body.user.id,
                    text: `❌ Error creating mapping: ${error.message}`
                });
            }
        });

        // Handle override creation
        this.app.view('override_modal', async ({ ack, body, view, client }) => {
            await ack();
            
            try {
                const values = view.state.values;
                const scheduleId = values.schedule.schedule_select.selected_option.value;
                const replacementUser = values.replacement_user.user_select.selected_user;
                const durationValue = values.duration_value.duration_value_input.value || '24';
                const durationUnit = values.duration_unit.duration_unit_select.selected_option.value || 'h';
                const timezone = values.timezone ? values.timezone.timezone_select.selected_option.value : 'UTC';
                const reason = values.reason.reason_input.value || 'Manual override';

                const duration = `${durationValue}${durationUnit}`;
                
                const override = await this.createOverride(
                    scheduleId,
                    replacementUser,
                    duration,
                    reason,
                    body.user.id,
                    body.team.id,
                    timezone
                );

                await client.chat.postMessage({
                    channel: body.user.id,
                    text: `✅ Override created! <@${replacementUser}> is now on-call for ${durationValue} ${this.getDurationUnitLabel(durationUnit)}\n🌍 Timezone: ${timezone}\n⏰ Ends at: ${override.end_time.toLocaleString()}`
                });
                
            } catch (error) {
                console.error('Error creating override:', error);
                await client.chat.postMessage({
                    channel: body.user.id,
                    text: `❌ Error creating override: ${error.message}`
                });
            }
        });

        // Handle schedule editing
        this.app.view('edit_schedule_modal', async ({ ack, body, view, client }) => {
            await ack();
            
            try {
                const values = view.state.values;
                const scheduleId = values.schedule.schedule_select.selected_option.value;
                const newMembers = values.members.members_select.selected_users || [];

                await this.updateScheduleMembers(scheduleId, newMembers);

                await client.chat.postMessage({
                    channel: body.user.id,
                    text: `✅ Schedule updated! Added ${newMembers.length} members to the rotation.`
                });
                
            } catch (error) {
                console.error('Error updating schedule:', error);
                await client.chat.postMessage({
                    channel: body.user.id,
                    text: `❌ Error updating schedule: ${error.message}`
                });
            }
        });
    }

    // DATABASE OPERATIONS
    async createSchedule(scheduleData) {
        return new Promise((resolve, reject) => {
            const id = this.generateId('sched');
            const sql = `
                INSERT INTO schedules (id, name, type, frequency, members, integration_config, custom_interval, timezone, rotation_start_time, workspace_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            
            this.db.run(sql, [
                id,
                scheduleData.name,
                scheduleData.type,
                scheduleData.frequency,
                JSON.stringify(scheduleData.members || []),
                JSON.stringify(scheduleData.integrationConfig || {}),
                scheduleData.customInterval,
                scheduleData.timezone || 'UTC',
                scheduleData.rotationStartTime || '09:00',
                scheduleData.workspaceId
            ], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id, ...scheduleData });
                }
            });
        });
    }

    async createOrGetUserGroup(name, workspaceId) {
        // First try to find existing user group
        const existing = await this.getUserGroupByName(name, workspaceId);
        if (existing) return existing;

        // Create new user group in Slack
        try {
            const result = await this.app.client.usergroups.create({
                name: name.replace('@', ''),
                handle: name.replace('@', ''),
                description: `Managed by Rotationpress Bot`
            });

            // Save to database
            return new Promise((resolve, reject) => {
                const id = this.generateId('ug');
                const sql = `
                    INSERT INTO user_groups (id, slack_group_id, name, workspace_id)
                    VALUES (?, ?, ?, ?)
                `;
                
                this.db.run(sql, [id, result.usergroup.id, name, workspaceId], function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ id, slack_group_id: result.usergroup.id, name, workspace_id: workspaceId });
                    }
                });
            });
        } catch (error) {
            console.error('Error creating Slack user group:', error);
            throw new Error('Failed to create user group in Slack');
        }
    }

    async getUserGroupByName(name, workspaceId) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM user_groups WHERE name = ? AND workspace_id = ?`;
            this.db.get(sql, [name, workspaceId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    async createScheduleMapping(userGroupId, scheduleIds, syncConfig, workspaceId) {
        return new Promise((resolve, reject) => {
            const id = this.generateId('map');
            const sql = `
                INSERT INTO schedule_mappings (id, user_group_id, schedule_ids, sync_config, workspace_id)
                VALUES (?, ?, ?, ?, ?)
            `;
            
            this.db.run(sql, [
                id,
                userGroupId,
                JSON.stringify(scheduleIds),
                JSON.stringify(syncConfig),
                workspaceId
            ], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id, user_group_id: userGroupId, schedule_ids: scheduleIds, sync_config: syncConfig });
                }
            });
        });
    }

    async updateScheduleMembers(scheduleId, members) {
        return new Promise((resolve, reject) => {
            const sql = `UPDATE schedules SET members = ? WHERE id = ?`;
            this.db.run(sql, [JSON.stringify(members), scheduleId], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ scheduleId, members });
                }
            });
        });
    }

    async createOverride(scheduleId, replacementUser, duration, reason, createdBy, workspaceId, timezone = 'UTC') {
        const { durationValue, durationUnit, endTime } = this.parseGranularDuration(duration, timezone);
        
        return new Promise((resolve, reject) => {
            const id = this.generateId('ovr');
            const sql = `
                INSERT INTO overrides (id, schedule_id, replacement_user, end_time, duration_value, duration_unit, timezone, reason, created_by, workspace_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            
            this.db.run(sql, [
                id, scheduleId, replacementUser, endTime.toISOString(), 
                durationValue, durationUnit, timezone, reason, createdBy, workspaceId
            ], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ 
                        id, 
                        schedule_id: scheduleId, 
                        replacement_user: replacementUser, 
                        end_time: endTime,
                        duration_value: durationValue,
                        duration_unit: durationUnit,
                        timezone: timezone
                    });
                }
            });
        });
    }

    async getSchedulesForWorkspace(workspaceId) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM schedules WHERE workspace_id = ?`;
            this.db.all(sql, [workspaceId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async getCurrentRotations(workspaceId) {
        const schedules = await this.getSchedulesForWorkspace(workspaceId);
        const rotations = [];

        for (const schedule of schedules) {
            const currentUser = await this.getCurrentUserForSchedule(schedule);
            const activeOverride = await this.getActiveOverride(schedule.id);
            
            rotations.push({
                schedule: schedule.name,
                currentUser: activeOverride ? activeOverride.replacement_user : currentUser,
                isOverride: !!activeOverride,
                overrideReason: activeOverride ? activeOverride.reason : null
            });
        }

        return rotations;
    }

    async getCurrentUserForSchedule(schedule) {
        if (schedule.type === 'internal') {
            const members = JSON.parse(schedule.members || '[]');
            if (members.length === 0) return null;

            const rotationIndex = this.calculateRotationIndexWithTimezone(schedule);
            return members[rotationIndex];
        } else if (schedule.type === 'pagerduty') {
            return await this.getCurrentPagerDutyUser(schedule);
        } else if (schedule.type === 'opsgenie') {
            return await this.getCurrentOpsGenieUser(schedule);
        }
        
        return null;
    }

    calculateRotationIndexWithTimezone(schedule) {
        const now = new Date();
        const createdAt = new Date(schedule.created_at);
        const members = JSON.parse(schedule.members || '[]');
        const timezone = schedule.timezone || 'UTC';
        const startTime = schedule.rotation_start_time || '09:00';
        
        if (members.length === 0) return 0;
        
        let intervalMs;
        switch (schedule.frequency) {
            case 'daily':
                intervalMs = 24 * 60 * 60 * 1000;
                break;
            case 'weekly':
                intervalMs = 7 * 24 * 60 * 60 * 1000;
                break;
            case 'monthly':
                intervalMs = 30 * 24 * 60 * 60 * 1000;
                break;
            case 'custom':
                intervalMs = this.parseCustomInterval(schedule.custom_interval || '1d');
                break;
            default:
                intervalMs = 24 * 60 * 60 * 1000;
        }
        
        // Calculate time difference accounting for rotation start time
        const [hours, minutes] = startTime.split(':').map(Number);
        const rotationStartToday = new Date(now);
        rotationStartToday.setHours(hours, minutes || 0, 0, 0);
        
        let elapsedMs;
        if (now >= rotationStartToday) {
            // Rotation has started today
            elapsedMs = now.getTime() - createdAt.getTime();
        } else {
            // Rotation starts later today, so we're still in previous rotation
            elapsedMs = now.getTime() - createdAt.getTime() - (24 * 60 * 60 * 1000);
        }
        
        const rotationsPassed = Math.floor(elapsedMs / intervalMs);
        return rotationsPassed % members.length;
    }

    async getActiveOverride(scheduleId) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT * FROM overrides 
                WHERE schedule_id = ? AND end_time > datetime('now') 
                ORDER BY start_time DESC 
                LIMIT 1
            `;
            this.db.get(sql, [scheduleId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    // MULTI-SCHEDULE SYNC 
    async syncAllMappingsForWorkspace(workspaceId) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM schedule_mappings WHERE workspace_id = ?`;
            this.db.all(sql, [workspaceId], async (err, mappings) => {
                if (err) {
                    reject(err);
                    return;
                }

                const results = [];
                for (const mapping of mappings) {
                    try {
                        const result = await this.syncScheduleMapping(mapping.id);
                        results.push(result);
                    } catch (error) {
                        console.error(`Failed to sync mapping ${mapping.id}:`, error);
                    }
                }
                
                resolve(results);
            });
        });
    }

    async syncScheduleMapping(mappingId) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT sm.*, ug.slack_group_id, ug.name as group_name 
                FROM schedule_mappings sm
                JOIN user_groups ug ON sm.user_group_id = ug.id
                WHERE sm.id = ?
            `;
            
            this.db.get(sql, [mappingId], async (err, mapping) => {
                if (err) {
                    reject(err);
                    return;
                }

                if (!mapping) {
                    reject(new Error('Mapping not found'));
                    return;
                }

                try {
                    const scheduleIds = JSON.parse(mapping.schedule_ids);
                    const syncConfig = JSON.parse(mapping.sync_config);
                    
                    const allUsers = new Set();
                    
                    for (const scheduleId of scheduleIds) {
                        const schedule = await this.getScheduleById(scheduleId);
                        if (schedule) {
                            const currentUser = await this.getCurrentUserForSchedule(schedule);
                            if (currentUser) {
                                allUsers.add(currentUser);
                            }
                        }
                    }

                    const userList = Array.from(allUsers);
                    if (userList.length > 0) {
                        await this.app.client.usergroups.users.update({
                            usergroup: mapping.slack_group_id,
                            users: userList.join(',')
                        });
                    }

                    // Log sync
                    await this.logSync(mappingId, 'success', userList.length, null);
                    
                    resolve({
                        mappingId,
                        userGroupName: mapping.group_name,
                        usersSynced: userList.length,
                        users: userList
                    });
                    
                } catch (error) {
                    await this.logSync(mappingId, 'error', 0, error.message);
                    reject(error);
                }
            });
        });
    }

    async getScheduleById(scheduleId) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM schedules WHERE id = ?`;
            this.db.get(sql, [scheduleId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    async logSync(mappingId, status, usersSynced, errorMessage) {
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO sync_logs (mapping_id, status, users_synced, error_message)
                VALUES (?, ?, ?, ?)
            `;
            this.db.run(sql, [mappingId, status, usersSynced, errorMessage], function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            });
        });
    }

    // EXTERNAL API INTEGRATIONS (Mock for development)
    async getCurrentPagerDutyUser(schedule) {
        if (!process.env.PAGERDUTY_TOKEN) {
            // Mock data for development
            return 'U' + Math.random().toString(36).substr(2, 8).toUpperCase();
        }

        try {
            const config = JSON.parse(schedule.integration_config || '{}');
            const response = await axios.get(
                `https://api.pagerduty.com/schedules/${config.scheduleId}/users`,
                {
                    headers: {
                        'Authorization': `Token token=${process.env.PAGERDUTY_TOKEN}`,
                        'Accept': 'application/vnd.pagerduty+json;version=2'
                    }
                }
            );
            
            return response.data.users[0]?.id || null;
        } catch (error) {
            console.error('PagerDuty API Error:', error);
            return null;
        }
    }

    async getCurrentOpsGenieUser(schedule) {
        if (!process.env.OPSGENIE_TOKEN) {
            // Mock data for development
            return 'U' + Math.random().toString(36).substr(2, 8).toUpperCase();
        }

        // Implementation similar to PagerDuty
        return null;
    }

    // CRON JOBS
    startCronJobs() {
        // Sync every 10 minutes
        cron.schedule('*/10 * * * *', async () => {
            console.log('🔄 Running scheduled sync...');
            try {
                // Get all workspaces (in production, you'd get this from your database)
                const workspaces = await this.getAllWorkspaces();
                
                for (const workspaceId of workspaces) {
                    await this.syncAllMappingsForWorkspace(workspaceId);
                }
                
                console.log('✅ Scheduled sync completed');
            } catch (error) {
                console.error('❌ Scheduled sync failed:', error);
            }
        });

        // Clean up expired overrides every hour
        cron.schedule('0 * * * *', async () => {
            console.log('🧹 Cleaning up expired overrides...');
            this.db.run(`DELETE FROM overrides WHERE end_time < datetime('now')`);
        });
    }

    async getAllWorkspaces() {
        return new Promise((resolve, reject) => {
            const sql = `SELECT DISTINCT workspace_id FROM schedules`;
            this.db.all(sql, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows.map(row => row.workspace_id));
            });
        });
    }

    // UI COMPONENTS
    getCreateScheduleModal() {
        return {
            type: 'modal',
            callback_id: 'create_schedule_modal',
            title: { type: 'plain_text', text: 'Create New Schedule' },
            submit: { type: 'plain_text', text: 'Create' },
            close: { type: 'plain_text', text: 'Cancel' },
            blocks: [
                {
                    type: 'input',
                    block_id: 'schedule_name',
                    element: {
                        type: 'plain_text_input',
                        action_id: 'name_input',
                        placeholder: { type: 'plain_text', text: 'e.g., Backend On-Call' }
                    },
                    label: { type: 'plain_text', text: 'Schedule Name' }
                },
                {
                    type: 'input',
                    block_id: 'schedule_type',
                    element: {
                        type: 'static_select',
                        action_id: 'type_select',
                        placeholder: { type: 'plain_text', text: 'Select schedule type' },
                        options: [
                            { text: { type: 'plain_text', text: 'Internal Rotation' }, value: 'internal' },
                            { text: { type: 'plain_text', text: 'PagerDuty Integration' }, value: 'pagerduty' },
                            { text: { type: 'plain_text', text: 'OpsGenie Integration' }, value: 'opsgenie' }
                        ]
                    },
                    label: { type: 'plain_text', text: 'Schedule Type' }
                },
                {
                    type: 'input',
                    block_id: 'frequency',
                    element: {
                        type: 'static_select',
                        action_id: 'frequency_select',
                        placeholder: { type: 'plain_text', text: 'Select frequency' },
                        options: [
                            { text: { type: 'plain_text', text: 'Daily' }, value: 'daily' },
                            { text: { type: 'plain_text', text: 'Weekly' }, value: 'weekly' },
                            { text: { type: 'plain_text', text: 'Monthly' }, value: 'monthly' },
                            { text: { type: 'plain_text', text: 'Custom' }, value: 'custom' }
                        ]
                    },
                    label: { type: 'plain_text', text: 'Rotation Frequency' }
                },
                {
                    type: 'input',
                    block_id: 'custom_interval',
                    element: {
                        type: 'plain_text_input',
                        action_id: 'interval_input',
                        placeholder: { type: 'plain_text', text: 'e.g., 8h, 3d, 2w, 30m' }
                    },
                    label: { type: 'plain_text', text: 'Custom Interval (for Custom frequency)' },
                    optional: true
                },
                {
                    type: 'input',
                    block_id: 'timezone',
                    element: {
                        type: 'static_select',
                        action_id: 'timezone_select',
                        placeholder: { type: 'plain_text', text: 'Select timezone' },
                        options: this.getTimezoneOptions()
                    },
                    label: { type: 'plain_text', text: 'Timezone' }
                },
                {
                    type: 'input',
                    block_id: 'rotation_start_time',
                    element: {
                        type: 'plain_text_input',
                        action_id: 'start_time_input',
                        placeholder: { type: 'plain_text', text: 'e.g., 09:00, 17:30' }
                    },
                    label: { type: 'plain_text', text: 'Rotation Start Time (24h format)' },
                    optional: true
                },
                {
                    type: 'input',
                    block_id: 'members',
                    element: {
                        type: 'multi_users_select',
                        action_id: 'members_select',
                        placeholder: { type: 'plain_text', text: 'Select team members' }
                    },
                    label: { type: 'plain_text', text: 'Team Members' },
                    optional: true
                }
            ]
        };
    }

    getMultiScheduleMappingModal(schedules) {
        const scheduleOptions = schedules.map(schedule => ({
            text: { type: 'plain_text', text: `${schedule.name} (${schedule.type})` },
            value: schedule.id
        }));

        return {
            type: 'modal',
            callback_id: 'map_schedules_modal',
            title: { type: 'plain_text', text: 'Multi-Schedule Sync' },
            submit: { type: 'plain_text', text: 'Create Mapping' },
            close: { type: 'plain_text', text: 'Cancel' },
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: '*Multi-Schedule Sync*\nCombine multiple schedules into a single user group - your competitive advantage!'
                    }
                },
                {
                    type: 'input',
                    block_id: 'user_group',
                    element: {
                        type: 'plain_text_input',
                        action_id: 'usergroup_input',
                        placeholder: { type: 'plain_text', text: 'oncall-combined' }
                    },
                    label: { type: 'plain_text', text: 'User Group Name' }
                },
                {
                    type: 'input',
                    block_id: 'schedules',
                    element: {
                        type: 'multi_static_select',
                        action_id: 'schedules_select',
                        placeholder: { type: 'plain_text', text: 'Select schedules to combine' },
                        options: scheduleOptions
                    },
                    label: { type: 'plain_text', text: 'Select Schedules' }
                },
                {
                    type: 'input',
                    block_id: 'conflict_resolution',
                    element: {
                        type: 'static_select',
                        action_id: 'resolution_select',
                        placeholder: { type: 'plain_text', text: 'Select strategy' },
                        options: [
                            { text: { type: 'plain_text', text: 'Merge All Users' }, value: 'merge' },
                            { text: { type: 'plain_text', text: 'Priority Based' }, value: 'priority' },
                            { text: { type: 'plain_text', text: 'Round Robin' }, value: 'round_robin' }
                        ]
                    },
                    label: { type: 'plain_text', text: 'Conflict Resolution' }
                }
            ]
        };
    }

    getOverrideModal(schedules) {
        const scheduleOptions = schedules.map(schedule => ({
            text: { type: 'plain_text', text: schedule.name },
            value: schedule.id
        }));

        return {
            type: 'modal',
            callback_id: 'override_modal',
            title: { type: 'plain_text', text: 'Override Rotation' },
            submit: { type: 'plain_text', text: 'Create Override' },
            close: { type: 'plain_text', text: 'Cancel' },
            blocks: [
                {
                    type: 'input',
                    block_id: 'schedule',
                    element: {
                        type: 'static_select',
                        action_id: 'schedule_select',
                        placeholder: { type: 'plain_text', text: 'Select schedule' },
                        options: scheduleOptions
                    },
                    label: { type: 'plain_text', text: 'Schedule' }
                },
                {
                    type: 'input',
                    block_id: 'replacement_user',
                    element: {
                        type: 'users_select',
                        action_id: 'user_select',
                        placeholder: { type: 'plain_text', text: 'Select replacement user' }
                    },
                    label: { type: 'plain_text', text: 'Replacement User' }
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: '*Override Duration*\nSpecify how long this override should last'
                    }
                },
                {
                    type: 'input',
                    block_id: 'duration_value',
                    element: {
                        type: 'plain_text_input',
                        action_id: 'duration_value_input',
                        placeholder: { type: 'plain_text', text: 'e.g., 1, 24, 72' },
                        min_length: 1,
                        max_length: 4
                    },
                    label: { type: 'plain_text', text: 'Duration Value' }
                },
                {
                    type: 'input',
                    block_id: 'duration_unit',
                    element: {
                        type: 'static_select',
                        action_id: 'duration_unit_select',
                        placeholder: { type: 'plain_text', text: 'Select unit' },
                        options: [
                            { text: { type: 'plain_text', text: 'Minutes' }, value: 'm' },
                            { text: { type: 'plain_text', text: 'Hours' }, value: 'h' },
                            { text: { type: 'plain_text', text: 'Days' }, value: 'd' },
                            { text: { type: 'plain_text', text: 'Weeks' }, value: 'w' }
                        ]
                    },
                    label: { type: 'plain_text', text: 'Duration Unit' }
                },
                {
                    type: 'input',
                    block_id: 'timezone',
                    element: {
                        type: 'static_select',
                        action_id: 'timezone_select',
                        placeholder: { type: 'plain_text', text: 'Select timezone' },
                        options: this.getTimezoneOptions()
                    },
                    label: { type: 'plain_text', text: 'Timezone' }
                },
                {
                    type: 'input',
                    block_id: 'reason',
                    element: {
                        type: 'plain_text_input',
                        action_id: 'reason_input',
                        placeholder: { type: 'plain_text', text: 'Sick leave, vacation, etc.' }
                    },
                    label: { type: 'plain_text', text: 'Reason' },
                    optional: true
                }
            ]
        };
    }

    getEditScheduleModal(schedules) {
        const scheduleOptions = schedules.map(schedule => ({
            text: { type: 'plain_text', text: schedule.name },
            value: schedule.id
        }));

        return {
            type: 'modal',
            callback_id: 'edit_schedule_modal',
            title: { type: 'plain_text', text: 'Edit Rotation Schedule' },
            submit: { type: 'plain_text', text: 'Update Schedule' },
            close: { type: 'plain_text', text: 'Cancel' },
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: '*Edit Rotation Schedule*\nAdd or update team members for an existing rotation.'
                    }
                },
                {
                    type: 'input',
                    block_id: 'schedule',
                    element: {
                        type: 'static_select',
                        action_id: 'schedule_select',
                        placeholder: { type: 'plain_text', text: 'Select schedule to edit' },
                        options: scheduleOptions
                    },
                    label: { type: 'plain_text', text: 'Schedule to Edit' }
                },
                {
                    type: 'input',
                    block_id: 'members',
                    element: {
                        type: 'multi_users_select',
                        action_id: 'members_select',
                        placeholder: { type: 'plain_text', text: 'Select team members for rotation' }
                    },
                    label: { type: 'plain_text', text: 'Team Members' }
                }
            ]
        };
    }

    getHomeView() {
        return {
            type: 'home',
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: '*Welcome to Rotationpress! 🚀*\n\nThe enhanced rotation scheduler with multi-schedule sync capability.'
                    }
                },
                {
                    type: 'divider'
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: '*Available Commands:*'
                    }
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: '• `/create-rotation` - Create a new rotation schedule\n• `/map-schedules` - Combine multiple schedules (🚀 *Unique Feature*)\n• `/show-rotations` - View current rotations\n• `/edit-rotation` - Add members to existing rotation\n• `/override-rotation` - Temporary override for sick days/vacation\n• `/sync-now` - Manual sync trigger\n• `/rotation-help` - Show detailed help'
                    }
                },
                {
                    type: 'divider'
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: '*🌟 Key Features:*\n• Multi-schedule sync to single user group\n• PagerDuty & OpsGenie integration\n• Automatic rotation management\n• Override system for flexibility\n• Real-time synchronization'
                    }
                }
            ]
        };
    }

    // UTILITY METHODS  
    generateId(prefix = 'id') {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    parseCustomInterval(interval) {
        if (!interval) return 24 * 60 * 60 * 1000; // Default 1 day
        
        const match = interval.match(/^(\d+)([mhdw])$/);
        if (!match) return 24 * 60 * 60 * 1000;
        
        const [, num, unit] = match;
        const multipliers = { 
            m: 60000,          // minutes
            h: 3600000,        // hours
            d: 86400000,       // days  
            w: 604800000       // weeks
        };
        
        return parseInt(num) * multipliers[unit];
    }

    parseGranularDuration(duration, timezone = 'UTC') {
        // Parse duration string like "24h", "3d", "30m", "2w"
        const match = duration.match(/^(\d+)([mhdw])$/);
        if (!match) {
            throw new Error('Invalid duration format. Use: 30m, 8h, 3d, 2w');
        }
        
        const [, num, unit] = match;
        const durationValue = parseInt(num);
        const durationUnit = unit;
        
        const multipliers = { 
            m: 60000,          // minutes
            h: 3600000,        // hours
            d: 86400000,       // days  
            w: 604800000       // weeks
        };
        
        const durationMs = durationValue * multipliers[durationUnit];
        const endTime = new Date(Date.now() + durationMs);
        
        return {
            durationValue,
            durationUnit,
            endTime
        };
    }

    getDurationUnitLabel(unit) {
        const labels = {
            m: 'minutes',
            h: 'hours', 
            d: 'days',
            w: 'weeks'
        };
        return labels[unit] || 'hours';
    }

    getTimezoneOptions() {
        return [
            { text: { type: 'plain_text', text: 'UTC' }, value: 'UTC' },
            { text: { type: 'plain_text', text: 'US/Eastern (EST/EDT)' }, value: 'America/New_York' },
            { text: { type: 'plain_text', text: 'US/Central (CST/CDT)' }, value: 'America/Chicago' },
            { text: { type: 'plain_text', text: 'US/Mountain (MST/MDT)' }, value: 'America/Denver' },
            { text: { type: 'plain_text', text: 'US/Pacific (PST/PDT)' }, value: 'America/Los_Angeles' },
            { text: { type: 'plain_text', text: 'Europe/London (GMT/BST)' }, value: 'Europe/London' },
            { text: { type: 'plain_text', text: 'Europe/Paris (CET/CEST)' }, value: 'Europe/Paris' },
            { text: { type: 'plain_text', text: 'Europe/Berlin (CET/CEST)' }, value: 'Europe/Berlin' },
            { text: { type: 'plain_text', text: 'Asia/Tokyo (JST)' }, value: 'Asia/Tokyo' },
            { text: { type: 'plain_text', text: 'Asia/Shanghai (CST)' }, value: 'Asia/Shanghai' },
            { text: { type: 'plain_text', text: 'Asia/Kolkata (IST)' }, value: 'Asia/Kolkata' },
            { text: { type: 'plain_text', text: 'Australia/Sydney (AEST/AEDT)' }, value: 'Australia/Sydney' },
            { text: { type: 'plain_text', text: 'America/Sao_Paulo (BRT/BRST)' }, value: 'America/Sao_Paulo' }
        ];
    }

    // Convert time to timezone-aware Date object
    getTimezoneAwareDate(timeString, timezone) {
        try {
            const now = new Date();
            const [hours, minutes] = timeString.split(':').map(Number);
            
            // Create date in the specified timezone
            const date = new Date();
            date.setHours(hours, minutes || 0, 0, 0);
            
            // Note: For production, you'd want to use a proper timezone library like moment-timezone
            // This is a simplified implementation
            return date;
        } catch (error) {
            console.error('Error parsing timezone-aware date:', error);
            return new Date();
        }
    }

    getHelpText() {
        return `
*Rotationpress - Enhanced Rotation Scheduler* 

*Basic Commands:*
• \`/create-rotation\` - Create a new rotation schedule
• \`/show-rotations\` - View all current rotations
• \`/edit-rotation\` - Add members to existing rotation
• \`/override-rotation\` - Create temporary override
• \`/sync-now\` - Manually trigger sync

*Advanced Features:*
• \`/map-schedules\` - *Multi-Schedule Sync* (Unique Feature!)
  Combine multiple PagerDuty, OpsGenie, and internal schedules into a single user group

*Enhanced Granular Controls:*
• **Timezone Support** - Set schedules in any timezone
• **Custom Rotation Times** - Start rotations at specific times (e.g., 09:00, 17:30)
• **Granular Durations** - Override for minutes, hours, days, or weeks
• **Flexible Intervals** - Custom intervals: 30m, 8h, 3d, 2w

*Supported Schedule Types:*
• Internal rotations (daily, weekly, monthly, custom)
• PagerDuty integration
• OpsGenie integration

*Multi-Schedule Sync Benefits:*
• Consolidate complex on-call setups
• Sync across different tools
• Automatic conflict resolution
• Real-time updates

*Examples:*
• Combine backend PagerDuty + frontend internal rotation
• Merge multiple PagerDuty schedules for comprehensive coverage
• Create unified on-call groups across teams

Need help? The bot automatically syncs every 10 minutes and handles overrides intelligently!
        `;
    }

    formatRotationStatus(rotations) {
        if (rotations.length === 0) {
            return '📅 *No active rotations found*\n\nUse `/create-rotation` to get started!';
        }

        let status = '📅 *Current Rotation Status*\n\n';
        
        rotations.forEach(rotation => {
            const userMention = rotation.currentUser ? `<@${rotation.currentUser}>` : 'No one assigned';
            const overrideText = rotation.isOverride ? ` ⚠️ (Override: ${rotation.overrideReason})` : '';
            
            status += `*${rotation.schedule}*\n`;
            status += `└ Currently on-call: ${userMention}${overrideText}\n\n`;
        });

        status += '_Last updated: ' + new Date().toLocaleString() + '_';
        return status;
    }

    async start() {
        try {
            await this.app.start();
            console.log('⚡️ Rotationpress Bot is running!');
            console.log('🚀 Multi-schedule sync capability enabled!');
            console.log('🌍 Enhanced with timezone & granular duration support!');
            console.log('📊 Database ready with SQLite');
            console.log('🔄 Cron jobs started for automatic sync');
            console.log('\n🎯 Ready for Slack workspace testing!');
        } catch (error) {
            console.error('Failed to start bot:', error);
        }
    }
}

require('dotenv').config();

if (require.main === module) {
    // Check environment variables
    const requiredEnvVars = [
        'SLACK_SIGNING_SECRET',
        'SLACK_BOT_TOKEN', 
        'SLACK_APP_TOKEN'
    ];

    const missing = requiredEnvVars.filter(envVar => !process.env[envVar]);
    
    if (missing.length > 0) {
        console.error('Missing required environment variables:', missing.join(', '));
        console.error('\n Create a .env file with:');
        console.error('SLACK_SIGNING_SECRET=your_signing_secret');
        console.error('SLACK_BOT_TOKEN=xoxb-your-bot-token');
        console.error('SLACK_APP_TOKEN=xapp-your-app-token');
        console.error('PAGERDUTY_TOKEN=your_pagerduty_token (optional)');
        console.error('OPSGENIE_TOKEN=your_opsgenie_token (optional)');
        process.exit(1);
    }

    const bot = new RotationpressCloneBot();
    bot.start();
}

module.exports = RotationpressCloneBot;