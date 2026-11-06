# Agent control / Управление агентами

## English

ChatGPT agents, including the swarm orchestrator, must control the harness exclusively through actual MCP tool calls. Never require or parse JSON-formatted assistant replies as control messages. Assistant replies are ordinary prose; structured arguments belong inside MCP calls. Missing tool calls or reasoning placeholders must not fail unused workers or automatically block the user's goal.

## Русский

Агенты ChatGPT, включая оркестратор субагентов, управляют harness исключительно настоящими вызовами MCP. Нельзя требовать или разбирать JSON-ответы ассистента как управляющие сообщения. Ответы ассистента — обычный текст; структурированные аргументы передаются внутри MCP-вызовов. Отсутствие вызова или индикатор размышления не должны проваливать незапущенных исполнителей или автоматически блокировать цель пользователя.
