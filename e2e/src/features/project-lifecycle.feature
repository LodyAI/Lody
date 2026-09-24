# language: en
@lody @essence @P1 @runtime-none @LODY-PROJECT-001
Feature: 本地项目目录在移除后保持安全

  Scenario: 用户添加、选择并移除本地 Git 项目而不删除原目录
    Given 用户已进入隔离的本地 workspace，且有一个合成 Git 项目
    When 用户通过项目选择器添加该本地文件夹
    And 用户从 sidebar 选择该项目
    And 用户确认原目录安全提示后移除该项目
    Then 该项目从本地 catalog 和项目选择器中消失
    And 原项目目录及其合成文件仍然存在
