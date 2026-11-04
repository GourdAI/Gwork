package com.gourdai.core.config.entity;

import lombok.Getter;
import lombok.Setter;

import java.util.ArrayList;
import java.util.List;

/**
 * 权限设置组（settings.json 的 {@code permission} 节点）。
 *
 * @author oisin
 */
@Setter
@Getter
public class PermissionGroupDo {
    //允许工具  {"**"};
    private final List<String> tools = new ArrayList<>();
    //禁用工具
    private final List<String> disallowedTools = new ArrayList<>();

    /**
     * bash 访问的<b>额外</b>豁免目录（工作区之外仍允许直接读写、不弹审批的位置）。
     *
     * <p><b>读写同时豁免</b>。字段名从早期的 {@code bashWriteExemptDirs} 改为
     * {@code bashExemptDirs} 正是因为口径从「只拦写」改成了「读写都拦」——
     * 旧名会成为一条虚假承诺：名字说只豁免写，实际行为却连读一起豁免。
     * 该配置项尚未对外发布过，改名零迁移成本。</p>
     *
     * <p>用途：有些项目的构建产物 / 本地仓库天然在工作区之外（如把输出写到
     * {@code D:\build-out}、读共享盘上的缓存目录）。没有这个配置项，用户只能整档切到
     * 「完全访问」——那是解除<b>全部</b>空间边界，代价远大于需求。</p>
     *
     * <p><b>只影响 bash 的路径轴</b>：</p>
     * <ul>
     *   <li>结构化文件工具（read/write/edit/ls/glob/grep）的边界由
     *       {@code TerminalSupport.resolveSafePath} 独立裁决，不读本清单；</li>
     *   <li>形态轴（递归删除、提权、关机、下载即执行、凭据访问、写启动文件）
     *       照旧生效——两轴独立、取更严者。豁免的语义是「不因为<b>越界</b>而弹审批」，
     *       不是「不因为<b>危险</b>而弹审批」。故 {@code rm -rf 豁免目录} 仍会弹审批。</li>
     * </ul>
     *
     * <p>与内置豁免清单（{@code BashPathGuard.defaultExemptRoots()}：构建缓存与临时目录）
     * 是<b>叠加</b>关系，本清单不替换内置项。</p>
     *
     * <p>条目支持 {@code ~} 与环境变量（{@code $env:X}、{@code %X%}）；相对路径按工作区解析
     * （等价于界内，通常无需配置）；非法或不存在的条目被静默忽略——少一项豁免只会让判定
     * <b>更严</b>（多弹一次审批），不会造成越权，故不需要报错打断保存。</p>
     */
    private final List<String> bashExemptDirs = new ArrayList<>();
}
